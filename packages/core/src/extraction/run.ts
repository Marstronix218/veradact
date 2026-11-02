// AI extraction (ARCHITECTURE §9.3, D-015, D-025). No transaction is held across the model call:
//
//   tx 1 — check org.ai_enabled AND engagement.ai_enabled (off → AiDisabledError before any model
//          client exists), read the source text and the active items, create the extraction_run.
//   model call, outside any transaction.
//   tx 2 — re-check the flags (switched off meanwhile → results discarded), verify quotes against
//          the stored text, validate `revises`, store candidates, finish the run with counts.
//
// Failures mark the run `failed` with a coded `error_code`; they never touch the ingest and never
// log content (ids, enums and counts only).
import { randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { candidate, engagement, extractionRun, getPgError, item, org, source, sourceContent, withTenant, type Db, type Tx } from "@veradact/db";
import { verifyCandidates, type ExistingItem, type ModelClient, type RawCandidate, type SourceType } from "@veradact/ai";
import { sha256Hex, type Kind } from "../domain";
import { AiDisabledError, DomainError } from "../errors";
import { log, logError, logId } from "../log";
import { listItems } from "../queries";

/** The prompt file every run uses (`packages/ai/prompts/extract.v1.md`). */
export const EXTRACTION_PROMPT_VERSION = "extract.v1";

const STATEMENT_MAX = 2000;
const SPEAKER_MAX = 200;
const MAX_DEPENDENCY_REFS = 20;
const ORDINAL_REF = /^#[1-9]\d{0,3}$/;
const SHORT_ID_REF = /^[A-Z0-9]{2,8}-[PCADR][1-9]\d{0,5}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** Builds the model client. Called only after the AI flags were checked inside the tenant transaction. */
export type ModelClientFactory = () => ModelClient | Promise<ModelClient>;

export interface RunExtractionInput {
  db: Db;
  orgId: string;
  userId: string;
  engagementId: string;
  sourceId: string;
  clock: () => Date;
  modelClientFactory: ModelClientFactory;
  /** Defaults to EXTRACTION_PROMPT_VERSION. */
  promptVersion?: string;
}

/** Something the run changed or dropped about a candidate (ids and codes only). */
export interface ExtractionNote {
  /** 1-based raw candidate position (`#n`). */
  ordinal: number;
  code: "revises_not_found" | "revises_not_active" | "revises_kind_mismatch" | "statement_too_long";
}

export interface ExtractionResult {
  runId: string;
  status: "succeeded" | "failed" | "discarded";
  /** Coded reason for `failed` / `discarded` (e.g. `rate_limited`, `ai_disabled`). */
  errorCode: string | null;
  model: string;
  promptVersion: string;
  /** Raw candidates the model returned. */
  proposed: number;
  /** Candidates written to the review queue. */
  stored: number;
  /** Raw candidates dropped (quote not found, unknown kind, ...). */
  dropped: number;
  /** Stored candidates whose quote offsets were corrected. */
  corrected: number;
  notes: ExtractionNote[];
}

interface AiFlags {
  org: boolean;
  engagement: boolean;
}

/** Reads both AI switches (FOR SHARE in tx 2, so a concurrent toggle waits for the run to finish). */
async function readAiFlags(tx: Tx, orgId: string, engagementId: string, lock: boolean): Promise<AiFlags> {
  const query = tx
    .select({ orgAi: org.aiEnabled, engagementAi: engagement.aiEnabled })
    .from(engagement)
    .innerJoin(org, eq(org.id, engagement.orgId))
    .where(and(eq(engagement.id, engagementId), eq(engagement.orgId, orgId)));
  const [row] = lock ? await query.for("share") : await query;
  if (!row) throw new DomainError("engagement_not_found");
  return { org: row.orgAi, engagement: row.engagementAi };
}

function assertAiOn(flags: AiFlags): void {
  if (!flags.org) throw new AiDisabledError("org");
  if (!flags.engagement) throw new AiDisabledError("engagement");
}

interface SourceText {
  text: string;
  sourceType: SourceType;
}

/**
 * The source's verified text, or a DomainError (unknown, redacted, or text that no longer matches its
 * hash). With `lock` (tx 2) the `source_content` row is held FOR SHARE until commit: `redactSource`
 * deletes that row first, so a redaction either finishes before this read (→ `source_redacted`) or
 * waits for the candidates to be stored and then deletes them with the source.
 */
async function readSourceText(tx: Tx, engagementId: string, sourceId: string, lock = false): Promise<SourceText> {
  if (lock) await tx.select({ id: sourceContent.sourceId }).from(sourceContent).where(eq(sourceContent.sourceId, sourceId)).for("share");
  const [row] = await tx
    .select({ sourceType: source.sourceType, sha: source.contentSha256, redactedAt: source.redactedAt, text: sourceContent.text })
    .from(source)
    .leftJoin(sourceContent, eq(sourceContent.sourceId, source.id))
    .where(and(eq(source.id, sourceId), eq(source.engagementId, engagementId)));
  if (!row) throw new DomainError("source_not_found", { sourceId });
  if (row.redactedAt) throw new DomainError("source_redacted", { sourceId });
  if (row.text === null || sha256Hex(row.text) !== row.sha) throw new DomainError("source_integrity_mismatch", { sourceId });
  return { text: row.text, sourceType: row.sourceType };
}

/** A coded, log-safe error code: `ModelClientError` / `IngestError` / DomainError codes, else `unknown`. */
export function extractionErrorCode(error: unknown): string {
  if (getPgError(error)) return "db_error";
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && ERROR_CODE.test(code) ? code : "unknown";
}

function cleanDependencyRefs(refs: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of refs) {
    const ref = raw.trim();
    if ((ORDINAL_REF.test(ref) || SHORT_ID_REF.test(ref)) && !out.includes(ref)) out.push(ref);
    if (out.length >= MAX_DEPENDENCY_REFS) break;
  }
  return out;
}

function cleanSpeaker(label: string | null): string | null {
  const trimmed = label?.trim() ?? "";
  return trimmed === "" ? null : trimmed.slice(0, SPEAKER_MAX);
}

async function finishRun(db: Db, ctx: { orgId: string; userId: string }, runId: string, values: Partial<typeof extractionRun.$inferInsert>): Promise<void> {
  await withTenant(db, ctx, (tx) => tx.update(extractionRun).set(values).where(eq(extractionRun.id, runId)));
}

/**
 * Runs AI extraction for one ingested source and fills the review queue. Throws `AiDisabledError`
 * (org or engagement switch off — checked before `modelClientFactory` is called, so no client is
 * even constructed) and DomainErrors for an unknown/redacted source; every later failure is
 * recorded on the run and returned as `status: 'failed'`.
 */
export async function runExtraction(input: RunExtractionInput): Promise<ExtractionResult> {
  const { db, orgId, userId, engagementId, sourceId, clock } = input;
  const tenant = { orgId, userId };
  const promptVersion = input.promptVersion ?? EXTRACTION_PROMPT_VERSION;
  const runId = randomUUID();
  const empty = { proposed: 0, stored: 0, dropped: 0, corrected: 0, notes: [] as ExtractionNote[] };

  // tx 1: flags first, then the source and context, then the client and the run row.
  const prepared = await withTenant(db, tenant, async (tx) => {
    assertAiOn(await readAiFlags(tx, orgId, engagementId, false));
    const src = await readSourceText(tx, engagementId, sourceId);
    const active = await listItems(tx, engagementId, { lifecycle: "active" });
    const existingItems: ExistingItem[] = active.map((i) => ({ short_id: i.shortId, kind: i.kind, status: i.status, statement: i.statement }));
    const createdAt = clock();
    let client: ModelClient;
    try {
      client = await input.modelClientFactory();
    } catch (error) {
      logError("extraction.client_unavailable", error, { runId: logId(runId) });
      await tx.insert(extractionRun).values({
        id: runId,
        orgId,
        engagementId,
        sourceId,
        model: "unavailable",
        promptVersion,
        status: "failed",
        errorCode: "client_unavailable",
        createdAt,
        finishedAt: createdAt,
      });
      return { failed: true as const, model: "unavailable" };
    }
    await tx.insert(extractionRun).values({ id: runId, orgId, engagementId, sourceId, model: client.name, promptVersion, status: "running", createdAt });
    return { failed: false as const, client, src, existingItems };
  });
  if (prepared.failed) return { runId, status: "failed", errorCode: "client_unavailable", model: prepared.model, promptVersion, ...empty };

  const { client, src, existingItems } = prepared;
  const model = client.name;
  log.info("extraction.started", { runId: logId(runId), sourceId: logId(sourceId), existingItems: existingItems.length });

  // Last check right before the text leaves: a switch turned off since tx 1 (e.g. while the
  // client was being built) stops the call. A switch turned off during the call discards the
  // results in tx 2 (ARCHITECTURE §9.3).
  const flagsNow = await withTenant(db, tenant, (tx) => readAiFlags(tx, orgId, engagementId, false));
  if (!flagsNow.org || !flagsNow.engagement) {
    await finishRun(db, tenant, runId, { status: "discarded", errorCode: "ai_disabled", finishedAt: clock() });
    log.info("extraction.discarded", { runId: logId(runId), reason: "ai_disabled", proposed: 0 });
    return { runId, status: "discarded", errorCode: "ai_disabled", model, promptVersion, ...empty };
  }

  // The model call: outside any transaction.
  let raw: RawCandidate[];
  try {
    raw = await client.extract({ sourceText: src.text, sourceType: src.sourceType, existingItems, promptVersion });
  } catch (error) {
    const errorCode = extractionErrorCode(error);
    logError("extraction.model_failed", error, { runId: logId(runId) });
    await finishRun(db, tenant, runId, { status: "failed", errorCode, finishedAt: clock() });
    return { runId, status: "failed", errorCode, model, promptVersion, ...empty };
  }

  // tx 2: re-check, verify, store.
  try {
    return await withTenant(db, tenant, async (tx) => {
      const flags = await readAiFlags(tx, orgId, engagementId, true);
      if (!flags.org || !flags.engagement) {
        await tx.update(extractionRun).set({ status: "discarded", errorCode: "ai_disabled", finishedAt: clock() }).where(eq(extractionRun.id, runId));
        log.info("extraction.discarded", { runId: logId(runId), reason: "ai_disabled", proposed: raw.length });
        return { runId, status: "discarded" as const, errorCode: "ai_disabled", model, promptVersion, ...empty, proposed: raw.length };
      }

      let current: SourceText;
      try {
        current = await readSourceText(tx, engagementId, sourceId, true);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        await tx.update(extractionRun).set({ status: "failed", errorCode: error.code, finishedAt: clock() }).where(eq(extractionRun.id, runId));
        return { runId, status: "failed" as const, errorCode: error.code, model, promptVersion, ...empty, proposed: raw.length };
      }

      const verified = verifyCandidates(current.text, raw);
      const notes: ExtractionNote[] = [];
      const items = await tx
        .select({ id: item.id, shortId: item.shortId, kind: item.kind, lifecycle: item.lifecycle })
        .from(item)
        .where(eq(item.engagementId, engagementId));
      const byShortId = new Map(items.map((i) => [i.shortId, i]));

      const createdAt = clock();
      const rows: (typeof candidate.$inferInsert)[] = [];
      for (const c of verified.accepted) {
        if (c.statement.length > STATEMENT_MAX) {
          notes.push({ ordinal: c.ordinal, code: "statement_too_long" });
          continue;
        }
        let revisesItemId: string | null = null;
        const revises = c.revises?.trim();
        if (revises) {
          const target = byShortId.get(revises);
          if (!target) notes.push({ ordinal: c.ordinal, code: "revises_not_found" });
          else if (target.lifecycle !== "active") notes.push({ ordinal: c.ordinal, code: "revises_not_active" });
          else if (target.kind !== c.kind) notes.push({ ordinal: c.ordinal, code: "revises_kind_mismatch" });
          else revisesItemId = target.id;
        }
        rows.push({
          id: randomUUID(),
          orgId,
          engagementId,
          sourceId,
          extractionRunId: runId,
          ordinal: c.ordinal,
          kind: c.kind as Kind,
          statement: c.statement,
          quote: c.quote,
          start: c.start,
          end: c.end,
          speakerLabel: cleanSpeaker(c.speaker_label),
          suggestedDependsOn: cleanDependencyRefs(c.suggested_depends_on),
          confidence: Number.isFinite(c.confidence) ? c.confidence : null,
          revisesItemId,
          verification: c.verification,
          status: "pending",
          createdAt,
        });
      }

      // A re-run replaces the source's still-pending suggestions from earlier runs.
      await tx
        .delete(candidate)
        .where(and(eq(candidate.sourceId, sourceId), eq(candidate.status, "pending"), ne(candidate.extractionRunId, runId)));
      if (rows.length > 0) await tx.insert(candidate).values(rows);

      const tooLong = notes.filter((n) => n.code === "statement_too_long").length;
      const dropped = verified.counts.dropped + tooLong;
      const corrected = rows.filter((r) => r.verification === "offset_corrected").length;
      await tx
        .update(extractionRun)
        .set({ status: "succeeded", proposedCount: raw.length, droppedCount: dropped, correctedCount: corrected, finishedAt: clock() })
        .where(eq(extractionRun.id, runId));
      log.info("extraction.finished", { runId: logId(runId), proposed: raw.length, stored: rows.length, dropped, corrected, notes: notes.length });
      return { runId, status: "succeeded" as const, errorCode: null, model, promptVersion, proposed: raw.length, stored: rows.length, dropped, corrected, notes };
    });
  } catch (error) {
    const errorCode = extractionErrorCode(error);
    logError("extraction.store_failed", error, { runId: logId(runId) });
    await finishRun(db, tenant, runId, { status: "failed", errorCode, finishedAt: clock() }).catch((e: unknown) => logError("extraction.finish_failed", e, { runId: logId(runId) }));
    return { runId, status: "failed", errorCode, model, promptVersion, ...empty, proposed: raw.length };
  }
}
