// Source commands: the consent gate (ARCHITECTURE §9.2, D-013) and redaction (§6).
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { auditLog, candidate, eventNote, source, sourceContent, withTenant } from "@veradact/db";
import { adminTestDb, testDb } from "@veradact/db/testing";
import { sha256Hex } from "../domain";
import { ConsentBlockedError, DomainError } from "../errors";
import { getItemDetail } from "../queries";
import { dumpProjections, loadState, readEventRows, rebuildProjections, verifyEngagementChain } from "../store";
import { createLedgerEngagement, NOTES_TEXT, type LedgerEngagement } from "../test-support/ledger";
import { createItem, reviseItem } from "./items";
import { ingestSource, redactSource, type IngestSourceInput } from "./sources";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(error instanceof DomainError)) throw new Error(`expected a DomainError, got ${String(error)}`);
  return error.code;
}

const TRANSCRIPT = "Dana: We need the export by Friday.\nLee: Agreed, Friday it is.\n";

function upload(e: LedgerEngagement, overrides: Partial<IngestSourceInput> = {}): IngestSourceInput {
  return {
    engagementId: e.engagementId,
    parsed: { text: TRANSCRIPT, rawText: TRANSCRIPT, segments: [{ speaker: "Dana", start: 0, end: 35 }] },
    title: "Weekly sync",
    filename: "sync.txt",
    format: "txt",
    sourceType: "machine_transcript",
    occurredAt: new Date("2026-02-27T16:00:00.000Z"),
    participants: ["Dana", "Lee"],
    attestation: { allParticipantsConsented: null, jurisdictions: ["CA", "NY"], jurisdictionsKnown: true },
    ...overrides,
  };
}

describe("consent gate", () => {
  it("blocks an unattested machine transcript with a participant in an all-party state", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const error = await ingestSource(e.ctx, upload(e)).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConsentBlockedError);
    const blocked = error as ConsentBlockedError;
    expect(blocked.code).toBe("consent_blocked");
    expect(blocked.rule).toBe("all_party_state_without_consent");
    expect(blocked.blockingStates).toEqual(["CA"]);
    expect(blocked.explanation).toMatch(/California/);
    // Nothing was written.
    const state = await withTenant(app.db, { orgId: e.orgId }, (tx) => loadState(tx, e.engagementId));
    expect(state.sources.size).toBe(1);
  });

  it("blocks unknown jurisdictions by default (D-013)", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const error = await ingestSource(e.ctx, upload(e, { attestation: { allParticipantsConsented: null, jurisdictions: [], jurisdictionsKnown: false } })).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ConsentBlockedError);
    expect((error as ConsentBlockedError).rule).toBe("unknown_jurisdiction_without_consent");
  });

  it("allows the same transcript when consent is attested, and records the attestation", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const { sourceId, events, consent } = await ingestSource(
      e.ctx,
      upload(e, { attestation: { allParticipantsConsented: true, jurisdictions: ["CA", "NY"], jurisdictionsKnown: true } }),
    );
    expect(consent.rule).toBe("consent_attested");
    expect(events[0]!.payload).toMatchObject({
      source_id: sourceId,
      source_type: "machine_transcript",
      format: "txt",
      content_sha256: sha256Hex(TRANSCRIPT),
      char_length: TRANSCRIPT.length,
      participant_count: 2,
      attestation: { attested_by: e.userId, all_participants_consented: true, participant_jurisdictions: ["CA", "NY"], rule: "consent_attested", decision: "allowed" },
    });
  });

  it("always allows human notes", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const { consent, events } = await ingestSource(e.ctx, upload(e, { sourceType: "human_notes", format: "md" }));
    expect(consent.rule).toBe("not_machine_transcript");
    expect((events[0]!.payload as { source_type: string }).source_type).toBe("human_notes");
  });

  it("treats a .vtt attested as human notes as a machine transcript", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const error = await ingestSource(e.ctx, upload(e, { sourceType: "human_notes", format: "vtt" })).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConsentBlockedError);
    const ok = await ingestSource(
      e.ctx,
      upload(e, { sourceType: "human_notes", format: "srt", attestation: { allParticipantsConsented: true, jurisdictions: ["CA"], jurisdictionsKnown: true } }),
    );
    expect((ok.events[0]!.payload as { source_type: string }).source_type).toBe("machine_transcript");
    expect(ok.consent.effectiveSourceType).toBe("machine_transcript");
  });
});

describe("ingestSource", () => {
  it("stores text and metadata off-log, the hash and counts in the log, occurred_at = source date, and audits", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const occurredAt = new Date("2026-02-27T16:00:00.000Z");
    const { sourceId, events } = await ingestSource(e.ctx, upload(e, { sourceType: "human_notes", occurredAt }));
    expect(events[0]!.occurredAt).toEqual(occurredAt);
    const raw = JSON.stringify(events[0]!.payload);
    for (const secret of ["Weekly sync", "sync.txt", "Dana", "Friday"]) expect(raw).not.toContain(secret);
    await withTenant(app.db, { orgId: e.orgId }, async (tx) => {
      const [content] = await tx.select().from(sourceContent).where(eq(sourceContent.sourceId, sourceId));
      expect(content).toMatchObject({ title: "Weekly sync", filename: "sync.txt", text: TRANSCRIPT, participants: ["Dana", "Lee"] });
      const audit = await tx.select().from(auditLog).where(and(eq(auditLog.targetId, sourceId), eq(auditLog.action, "source.ingest")));
      expect(audit).toHaveLength(1);
    });
  });

  it("rejects empty and non-normalized text", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    expect(await codeOf(ingestSource(e.ctx, upload(e, { sourceType: "human_notes", parsed: { text: " \n\t", rawText: " ", segments: [] } })))).toBe("source_empty");
    const decomposed = "Café notes";
    expect(await codeOf(ingestSource(e.ctx, upload(e, { sourceType: "human_notes", parsed: { text: decomposed, rawText: decomposed, segments: [] } })))).toBe(
      "source_not_normalized",
    );
    expect(await codeOf(ingestSource(e.ctx, upload(e, { sourceType: "human_notes", parsed: { text: "a\r\nb", rawText: "a\r\nb", segments: [] } })))).toBe(
      "source_not_normalized",
    );
  });
});

describe("redaction", () => {
  it("deletes the text and pending candidates; items keep their spans and content hash and render as redacted; revising with carried spans works", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const quote = "Invoices are exported nightly to the carrier portal.";
    const created = await createItem(e.ctx, { engagementId: e.engagementId, kind: "requirement", statement: "Nightly invoice export", spans: [{ sourceId: e.sourceId, quote }] });
    const start = NOTES_TEXT.indexOf(quote);
    // One pending and one accepted candidate from this source.
    await withTenant(app.db, { orgId: e.orgId }, async (tx) => {
      const base = {
        orgId: e.orgId,
        engagementId: e.engagementId,
        sourceId: e.sourceId,
        extractionRunId: "00000000-0000-4000-8000-0000000000e1",
        kind: "requirement" as const,
        statement: "Synthetic candidate",
        quote,
        start,
        end: start + quote.length,
        verification: "exact" as const,
        createdAt: new Date("2026-03-02T15:10:00.000Z"),
      };
      await tx.insert(candidate).values([
        { ...base, ordinal: 1, status: "pending" },
        { ...base, ordinal: 2, status: "accepted", resultingItemId: created.itemId },
      ]);
    });

    const before = await withTenant(app.db, { orgId: e.orgId }, (tx) => getItemDetail(tx, e.engagementId, created.itemId));
    expect(before!.versions[0]!.spans[0]).toMatchObject({ quote, quoteState: "verified", sourceTitle: "Kickoff notes", sourceOccurredAt: e.sourceOccurredAt });

    const { events } = await redactSource(e.ctx, { engagementId: e.engagementId, sourceId: e.sourceId, reasonCode: "user_request", note: "Client asked us to remove it" });
    expect(events[0]).toMatchObject({ type: "source_redacted", payload: { source_id: e.sourceId, reason_code: "user_request" } });

    await withTenant(app.db, { orgId: e.orgId }, async (tx) => {
      expect(await tx.select().from(sourceContent).where(eq(sourceContent.sourceId, e.sourceId))).toEqual([]);
      const remaining = await tx.select({ status: candidate.status }).from(candidate).where(eq(candidate.sourceId, e.sourceId));
      expect(remaining.map((c) => c.status)).toEqual(["accepted"]);
      const [src] = await tx.select().from(source).where(eq(source.id, e.sourceId));
      expect(src).toMatchObject({ redactionReason: "user_request" });
      expect(src!.redactedAt).toEqual(events[0]!.recordedAt);
      const rows = await readEventRows(tx, e.engagementId);
      const redactEventId = rows.find((r) => r.event.type === "source_redacted")!.id;
      const [note] = await tx.select().from(eventNote).where(eq(eventNote.eventId, redactEventId));
      expect(note?.note).toBe("Client asked us to remove it");
      expect(await tx.select().from(auditLog).where(and(eq(auditLog.targetId, e.sourceId), eq(auditLog.action, "source.redact")))).toHaveLength(1);
    });

    const after = await withTenant(app.db, { orgId: e.orgId }, (tx) => getItemDetail(tx, e.engagementId, created.itemId));
    const span = after!.versions[0]!.spans[0]!;
    expect(span).toMatchObject({ quote: null, quoteState: "redacted", start, end: start + quote.length, sourceTitle: null });
    expect(span.sourceRedactedAt).toEqual(events[0]!.recordedAt);
    expect(after!.versions[0]!.contentHash).toBe(created.contentHash);

    // New citations of the redacted source are rejected; carried spans are not re-verified.
    expect(
      await codeOf(createItem(e.ctx, { engagementId: e.engagementId, kind: "constraint", statement: "x", spans: [{ sourceId: e.sourceId, quote: "Kickoff call" }] })),
    ).toBe("source_redacted");
    const revised = await reviseItem(e.ctx, { engagementId: e.engagementId, itemId: created.itemId, statement: "Nightly invoice export at 02:00", reasonCode: "new_information" });
    expect(revised.events[0]!.payload).toMatchObject({ version: 2, spans: [{ source_id: e.sourceId, start, end: start + quote.length }], manual: null });
    const v2 = await withTenant(app.db, { orgId: e.orgId }, (tx) => getItemDetail(tx, e.engagementId, created.shortId));
    expect(v2!.versions[1]!.spans[0]).toMatchObject({ carried: true, quoteState: "redacted" });

    expect(await codeOf(redactSource(e.ctx, { engagementId: e.engagementId, sourceId: e.sourceId, reasonCode: "other" }))).toBe("source_redacted");
    await withTenant(app.db, { orgId: e.orgId }, async (tx) => {
      expect((await verifyEngagementChain(tx, e.engagementId)).ok).toBe(true);
      const live = await dumpProjections(tx, e.engagementId);
      await rebuildProjections(tx, e.engagementId);
      expect(await dumpProjections(tx, e.engagementId)).toEqual(live);
    });
  });

  it("a system actor (retention) can redact", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const { events } = await redactSource({ ...e.ctx, userId: null }, { engagementId: e.engagementId, sourceId: e.sourceId, reasonCode: "retention" });
    expect(events[0]!.actor).toEqual({ type: "system", id: null });
  });
});
