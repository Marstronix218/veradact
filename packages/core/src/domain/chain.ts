/**
 * Hash chain (ARCHITECTURE §4).
 *
 * hash = sha256_hex(canonical({
 *   v: 1, org_id, engagement_id, seq, type, schema_version,
 *   payload, actor: { type, id }, occurred_at, recorded_at, prev_hash
 * }))
 */
import { canonicalJson } from "./canonical";
import { OCCURRED_AT_EVENT_TYPES, SCHEMA_VERSION, type EventDraft, type StoredEvent } from "./events";
import { sha256Hex } from "./hash";

export const GENESIS_PREV_HASH = "0".repeat(64);
export const HASH_FORMAT_VERSION = 1;

/** Raw row values covered by the hash (payload as plain JSON, Dates for timestamps). */
export interface HashableEvent {
  orgId: string;
  engagementId: string;
  seq: number;
  type: string;
  schemaVersion: number;
  payload: unknown;
  actor: { type: string; id: string | null };
  occurredAt: Date;
  recordedAt: Date;
  prevHash: string;
}

export interface ChainRow extends HashableEvent {
  hash: string;
}

export function computeEventHash(fields: HashableEvent): string {
  return sha256Hex(
    canonicalJson({
      v: HASH_FORMAT_VERSION,
      org_id: fields.orgId,
      engagement_id: fields.engagementId,
      seq: fields.seq,
      type: fields.type,
      schema_version: fields.schemaVersion,
      payload: fields.payload,
      actor: { type: fields.actor.type, id: fields.actor.id },
      occurred_at: fields.occurredAt.toISOString(),
      recorded_at: fields.recordedAt.toISOString(),
      prev_hash: fields.prevHash,
    }),
  );
}

export interface ChainHead {
  seq: number;
  hash: string;
}

export type ChainFailureReason = "seq_gap" | "prev_hash_mismatch" | "hash_mismatch" | "truncated";

export interface ChainVerification {
  ok: boolean;
  /** Rows verified successfully (from seq 1) before the first failure, or all rows. */
  checked: number;
  /** Seq and hash of the last verified row (0 and `GENESIS_PREV_HASH` for an empty log). */
  headSeq: number;
  headHash: string;
  /**
   * The seq position at which verification failed: the expected seq of the offending row
   * (`seq_gap`, `prev_hash_mismatch`, `hash_mismatch`), the first missing seq when the log is
   * shorter than `expectedHead`, or `expectedHead.seq` when the log diverges from it.
   */
  firstBadSeq?: number;
  reason?: ChainFailureReason;
}

/**
 * Verifies a full engagement log from genesis. `rows` must be in seq order (as stored); any gap,
 * duplicate or reordering is `seq_gap`. `expectedHead` (from `engagement_head`, an export or a
 * receipt) must be a prefix point of the log: a log shorter than it, or whose row at
 * `expectedHead.seq` has a different hash, is `truncated`.
 */
export function verifyChain(rows: readonly ChainRow[], expectedHead?: ChainHead | null): ChainVerification {
  let headSeq = 0;
  let headHash = GENESIS_PREV_HASH;
  const fail = (reason: ChainFailureReason, firstBadSeq: number): ChainVerification => ({
    ok: false,
    checked: headSeq,
    headSeq,
    headHash,
    firstBadSeq,
    reason,
  });

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const expectedSeq = i + 1;
    if (row.seq !== expectedSeq) return fail("seq_gap", expectedSeq);
    if (row.prevHash !== headHash) return fail("prev_hash_mismatch", expectedSeq);
    let computed: string;
    try {
      computed = computeEventHash(row);
    } catch {
      return fail("hash_mismatch", expectedSeq);
    }
    if (computed !== row.hash) return fail("hash_mismatch", expectedSeq);
    headSeq = row.seq;
    headHash = row.hash;
  }

  if (expectedHead && expectedHead.seq > 0) {
    if (expectedHead.seq > headSeq) return fail("truncated", headSeq + 1);
    if (rows[expectedHead.seq - 1]!.hash !== expectedHead.hash) return fail("truncated", expectedHead.seq);
  }
  return { ok: true, checked: headSeq, headSeq, headHash };
}

/** `recorded_at = max(clock(), head.recorded_at)` at millisecond precision (§4). */
export function nextRecordedAt(now: Date, headRecordedAt: Date | null): Date {
  const t = Math.trunc(now.getTime());
  if (Number.isNaN(t)) throw new RangeError("clock returned an invalid Date");
  return new Date(headRecordedAt && headRecordedAt.getTime() > t ? headRecordedAt.getTime() : t);
}

/**
 * `occurred_at` for a draft: the draft's value for source and item-version events (falling back to
 * the recorded time), and the recorded time for everything else (ARCHITECTURE §2.2).
 */
export function resolveOccurredAt(draft: Pick<EventDraft, "type" | "occurredAt">, recordedAt: Date): Date {
  if (OCCURRED_AT_EVENT_TYPES.has(draft.type) && draft.occurredAt) return new Date(Math.trunc(draft.occurredAt.getTime()));
  return new Date(recordedAt.getTime());
}

export interface SealContext {
  orgId: string;
  engagementId: string;
  seq: number;
  prevHash: string;
  recordedAt: Date;
}

/**
 * Turns a (validated) draft into a stored event: assigns seq, prev_hash, recorded_at, occurred_at
 * and schema_version, and computes the hash. Pure; the append API calls it once per draft with the
 * current head, and the insert trigger re-checks seq and prev_hash.
 */
export function sealEvent(draft: EventDraft, ctx: SealContext): StoredEvent {
  const recordedAt = new Date(Math.trunc(ctx.recordedAt.getTime()));
  const base = {
    orgId: ctx.orgId,
    engagementId: ctx.engagementId,
    seq: ctx.seq,
    type: draft.type,
    schemaVersion: SCHEMA_VERSION,
    payload: structuredClone(draft.payload),
    actor: { type: draft.actor.type, id: draft.actor.id },
    occurredAt: resolveOccurredAt(draft, recordedAt),
    recordedAt,
    prevHash: ctx.prevHash,
  };
  return { ...base, hash: computeEventHash(base) } as StoredEvent;
}
