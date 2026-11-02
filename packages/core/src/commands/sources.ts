// Source ingest and redaction (ARCHITECTURE §2.3, §2.4, §6, §9.2).
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { candidate, org, sourceContent } from "@veradact/db";
import { writeAudit } from "../audit";
import {
  buildAttestation,
  evaluateConsent,
  sha256Hex,
  type ConsentInput,
  type ConsentPolicy,
  type ConsentResult,
  type EngagementState,
  type SourceFormat,
  type SourceRedactionReason,
  type SourceType,
  type StoredEvent,
} from "../domain";
import { ConsentBlockedError, DomainError } from "../errors";
import { appendEvents } from "../store";
import { fixedClock, lockAndLoad, runInTenant, userActor, userOrSystemActor, type CommandContext, type UserOrSystemContext } from "./context";
import { cleanNote, writeNote } from "./notes";

const TITLE_MAX = 300;

/** Output of `@veradact/ingest`'s `parseSource` (text already normalized per ARCHITECTURE §1.1). */
export interface ParsedSourceInput {
  text: string;
  rawText: string;
  segments: readonly { speaker: string | null; start: number; end: number }[];
}

export interface IngestSourceInput {
  engagementId: string;
  /** Defaults to a random UUID. */
  sourceId?: string;
  parsed: ParsedSourceInput;
  title?: string | null;
  filename?: string | null;
  format: SourceFormat;
  /** As selected by the uploader; `.vtt`/`.srt` are always treated as `machine_transcript`. */
  sourceType: SourceType;
  /** When the conversation happened (the source date). */
  occurredAt: Date;
  /** Participant names/labels as given (stored in `source_content`, counted in the event). */
  participants?: readonly string[];
  attestation: {
    allParticipantsConsented: boolean | null;
    jurisdictions: readonly string[];
    jurisdictionsKnown: boolean;
  };
}

export interface IngestSourceResult {
  sourceId: string;
  events: StoredEvent[];
  state: EngagementState;
  consent: ConsentResult & { decision: "allowed" };
}

function isNormalized(text: string): boolean {
  return !text.startsWith("﻿") && text.replace(/\r\n?/g, "\n").normalize("NFC") === text;
}

function cleanOptional(value: string | null | undefined, max: number): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, max);
}

/**
 * Applies the org's consent policy (blocked → `ConsentBlockedError` with the explanation), stores
 * the text in `source_content` and appends `source_ingested` (occurred_at = source date). The log
 * gets the content hash, length, counts and attestation — never text, title or filename.
 */
export async function ingestSource(ctx: CommandContext, input: IngestSourceInput): Promise<IngestSourceResult> {
  const { text } = input.parsed;
  if (text.trim() === "") throw new DomainError("source_empty");
  if (!isNormalized(text)) throw new DomainError("source_not_normalized");
  if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime())) throw new DomainError("invalid_source_date");
  const participants = [...(input.participants ?? [])];
  const sourceId = input.sourceId ?? randomUUID();

  return runInTenant(ctx, async (tx) => {
    const { state } = await lockAndLoad(tx, input.engagementId);
    if (state.sources.has(sourceId)) throw new DomainError("invalid_event", { type: "source_ingested", issues: ["source id already used"] });

    const [settings] = await tx
      .select({ allPartyStates: org.allPartyStates, blockUnknownJurisdictions: org.blockUnknownJurisdictions })
      .from(org)
      .where(eq(org.id, ctx.orgId));
    if (!settings) throw new DomainError("engagement_not_found");
    const policy: ConsentPolicy = { allPartyStates: settings.allPartyStates, blockUnknownJurisdictions: settings.blockUnknownJurisdictions };
    const consentInput: ConsentInput = {
      sourceType: input.sourceType,
      format: input.format,
      allParticipantsConsented: input.attestation.allParticipantsConsented,
      jurisdictions: input.attestation.jurisdictions,
      jurisdictionsKnown: input.attestation.jurisdictionsKnown,
    };
    const consent = evaluateConsent(consentInput, policy);
    if (consent.decision === "blocked") throw new ConsentBlockedError(consent);

    await tx.insert(sourceContent).values({
      sourceId,
      orgId: ctx.orgId,
      engagementId: input.engagementId,
      title: cleanOptional(input.title, TITLE_MAX),
      filename: cleanOptional(input.filename, TITLE_MAX),
      text,
      rawText: input.parsed.rawText,
      participants,
      segments: input.parsed.segments.map((s) => ({ speaker: s.speaker, start: s.start, end: s.end })),
    });

    const now = ctx.clock();
    const result = await appendEvents(
      tx,
      input.engagementId,
      [
        {
          type: "source_ingested",
          actor: userActor(ctx.userId),
          occurredAt: input.occurredAt,
          payload: {
            source_id: sourceId,
            source_type: consent.effectiveSourceType,
            format: input.format,
            content_sha256: sha256Hex(text),
            char_length: text.length,
            participant_count: participants.length,
            attestation: buildAttestation(consentInput, policy, consent, ctx.userId),
          },
        },
      ],
      { clock: fixedClock(now), state },
    );
    await writeAudit(tx, {
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      action: "source.ingest",
      targetType: "source",
      targetId: sourceId,
      metadata: { source_type: consent.effectiveSourceType, format: input.format, rule: consent.rule },
      at: now,
    });
    return { sourceId, events: result.events, state: result.state, consent };
  });
}

export interface RedactSourceInput {
  engagementId: string;
  sourceId: string;
  reasonCode: SourceRedactionReason;
  /** Optional explanation, stored in `event_note` (never in the log). */
  note?: string | null;
}

/**
 * Deletes `source_content` and the source's pending candidates, appends `source_redacted` and
 * audits. Item versions keep their spans (and content hashes); quotes can no longer be shown.
 * `ctx.userId = null` records the `system` actor (retention).
 */
export async function redactSource(
  ctx: UserOrSystemContext,
  input: RedactSourceInput,
): Promise<{ events: StoredEvent[]; state: EngagementState }> {
  const note = cleanNote(input.note);
  return runInTenant(ctx, async (tx) => {
    const { state } = await lockAndLoad(tx, input.engagementId);
    const source = state.sources.get(input.sourceId);
    if (!source) throw new DomainError("source_not_found", { sourceId: input.sourceId });
    if (source.redacted) throw new DomainError("source_redacted", { sourceId: input.sourceId });

    await tx.delete(sourceContent).where(eq(sourceContent.sourceId, input.sourceId));
    await tx.delete(candidate).where(and(eq(candidate.sourceId, input.sourceId), eq(candidate.status, "pending")));

    const now = ctx.clock();
    const result = await appendEvents(
      tx,
      input.engagementId,
      [{ type: "source_redacted", actor: userOrSystemActor(ctx.userId), payload: { source_id: input.sourceId, reason_code: input.reasonCode } }],
      { clock: fixedClock(now), state },
    );
    await writeNote(tx, ctx.orgId, result.eventIds[0]!, note);
    await writeAudit(tx, {
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      action: "source.redact",
      targetType: "source",
      targetId: input.sourceId,
      metadata: { reason_code: input.reasonCode },
      at: now,
    });
    return { events: result.events, state: result.state };
  });
}
