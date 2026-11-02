// Append API, live path (ARCHITECTURE §5.2). Always called inside withTenant(); commits together
// with the caller's operational writes.
import { eq, sql } from "drizzle-orm";
import { engagement, engagementHead, event, type Tx } from "@veradact/db";
import {
  EventValidationError,
  itemContentHash,
  nextRecordedAt,
  parseEventDraft,
  reduce,
  sealEvent,
  type EngagementState,
  type EventDraft,
  type StoredEvent,
} from "../domain";
import { DomainError } from "../errors";
import { loadState } from "./load-state";
import { writeProjections } from "./projection-writer";

export interface AppendOptions {
  /** Application clock; called exactly once per draft. */
  clock: () => Date;
  /**
   * State the caller folded after taking `lockEngagement` in this transaction. Used instead of
   * re-folding the log when it is still at the stored head (checked against `engagement_head`).
   */
  state?: EngagementState;
}

export interface AppendResult {
  /** The appended events as stored (raw payloads), in seq order. */
  events: StoredEvent[];
  /** Global row ids (`event.id`) of `events`, same order; side tables reference these. */
  eventIds: number[];
  /** State after the appended events. */
  state: EngagementState;
}

/**
 * Serializes writers per engagement for the rest of the transaction (READ COMMITTED, so reads
 * after the lock see the latest committed log). Re-entrant within one transaction.
 */
export async function lockEngagement(tx: Tx, engagementId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${engagementId}::text, 0))`);
}

/** The engagement row's org id, or `engagement_not_found` when it is not visible to this tenant. */
async function engagementOrgId(tx: Tx, engagementId: string): Promise<string> {
  const [row] = await tx.select({ orgId: engagement.orgId }).from(engagement).where(eq(engagement.id, engagementId));
  if (!row) throw new DomainError("engagement_not_found");
  return row.orgId;
}

async function currentState(tx: Tx, engagementId: string, given: EngagementState | undefined): Promise<EngagementState> {
  if (given) {
    const [head] = await tx
      .select({ seq: engagementHead.headSeq, hash: engagementHead.headHash })
      .from(engagementHead)
      .where(eq(engagementHead.engagementId, engagementId));
    const headSeq = head?.seq ?? 0;
    if (headSeq === given.headSeq && (head === undefined || head.hash === given.headHash)) return given;
  }
  return loadState(tx, engagementId);
}

function validate(draft: EventDraft, state: EngagementState, engagementId: string): EventDraft {
  let parsed: EventDraft;
  try {
    parsed = parseEventDraft(draft);
  } catch (error) {
    if (error instanceof EventValidationError) {
      throw new DomainError("invalid_event", { type: draft.type, issues: [...error.issues] });
    }
    throw error;
  }
  // Structural rules of the log itself; business rules are the commands' job.
  if (state.headSeq === 0) {
    if (parsed.type !== "engagement_created" || parsed.payload.engagement_id !== engagementId) {
      throw new DomainError("invalid_event", { type: parsed.type, issues: ["genesis must be engagement_created for this engagement"] });
    }
  } else if (parsed.type === "engagement_created") {
    throw new DomainError("invalid_event", { type: parsed.type, issues: ["engagement_created is only allowed as the first event"] });
  }
  // A version's content hash is what confirmations bind to (invariant 4): it must be the hash of
  // the version's content, not whatever the caller put in the payload. A revision of an item that
  // does not exist has no kind to hash with, so it is refused rather than left unchecked.
  if (parsed.type === "item_created" || parsed.type === "item_revised") {
    const p = parsed.payload;
    const kind = parsed.type === "item_created" ? parsed.payload.kind : state.items.get(p.item_id)?.kind;
    if (kind === undefined) throw new DomainError("item_not_found", { itemId: p.item_id });
    const expected = itemContentHash({ engagement_id: engagementId, item_id: p.item_id, kind, version: p.version, statement: p.statement, spans: p.spans, manual: p.manual });
    if (expected !== p.content_hash) throw new DomainError("invalid_event", { type: parsed.type, issues: ["payload.content_hash: does not match the version content"] });
  }
  return parsed;
}

/**
 * Appends `drafts` to the engagement's log: lock, load state, then per draft validate, assign
 * seq / recorded_at (= max(clock() truncated to ms, head.recorded_at)) / prev_hash, compute the
 * hash and reduce; insert the sealed rows; rewrite the engagement's projections from the new state.
 */
export async function appendEvents(
  tx: Tx,
  engagementId: string,
  drafts: readonly EventDraft[],
  options: AppendOptions,
): Promise<AppendResult> {
  await lockEngagement(tx, engagementId);
  const orgId = await engagementOrgId(tx, engagementId);
  let state = await currentState(tx, engagementId, options.state);
  if (drafts.length === 0) return { events: [], eventIds: [], state };

  const events: StoredEvent[] = [];
  for (const draft of drafts) {
    const parsed = validate(draft, state, engagementId);
    const recordedAt = nextRecordedAt(options.clock(), state.headRecordedAt);
    const stored = sealEvent(parsed, { orgId, engagementId, seq: state.headSeq + 1, prevHash: state.headHash, recordedAt });
    events.push(stored);
    state = reduce(state, stored);
  }

  // One statement; the BEFORE INSERT trigger re-checks seq, prev_hash and recorded_at row by row.
  const inserted = await tx
    .insert(event)
    .values(
      events.map((e) => ({
        orgId: e.orgId,
        engagementId: e.engagementId,
        seq: e.seq,
        type: e.type,
        schemaVersion: e.schemaVersion,
        payload: e.payload,
        actorType: e.actor.type,
        actorId: e.actor.id,
        occurredAt: e.occurredAt,
        recordedAt: e.recordedAt,
        prevHash: e.prevHash,
        hash: e.hash,
      })),
    )
    .returning({ id: event.id, seq: event.seq });
  const idBySeq = new Map(inserted.map((r) => [r.seq, r.id]));
  const eventIds = events.map((e) => {
    const id = idBySeq.get(e.seq);
    if (id === undefined) throw new Error("appendEvents: inserted row missing");
    return id;
  });

  await writeProjections(tx, state, engagementId);
  return { events, eventIds, state };
}
