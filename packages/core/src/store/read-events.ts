// Reads an engagement's log as StoredEvent[] (ARCHITECTURE §4, §5). Payloads are the raw jsonb
// values returned by the driver (never zod output) and timestamps are Dates, so the rows can be
// hashed by `verifyChain` and folded by `reduce` as stored.
import { and, asc, eq, lte, type SQL } from "drizzle-orm";
import { event, type Tx } from "@veradact/db";
import type { StoredEvent } from "../domain";

export interface ReadEventsOptions {
  /** Only events with `seq <= throughSeq`. */
  throughSeq?: number;
  /** Only events with `recorded_at <= recordedAtOrBefore` (replay cut-off). */
  recordedAtOrBefore?: Date;
}

/** A stored event plus its global row id (`event.id`), which side tables reference. */
export interface StoredEventRow {
  id: number;
  event: StoredEvent;
}

type EventRow = typeof event.$inferSelect;

export function toStoredEvent(row: EventRow): StoredEvent {
  return {
    orgId: row.orgId,
    engagementId: row.engagementId,
    seq: row.seq,
    type: row.type,
    schemaVersion: row.schemaVersion,
    payload: row.payload,
    actor: { type: row.actorType, id: row.actorId },
    occurredAt: row.occurredAt,
    recordedAt: row.recordedAt,
    prevHash: row.prevHash,
    hash: row.hash,
  } as StoredEvent;
}

function filters(engagementId: string, options: ReadEventsOptions): SQL | undefined {
  const conditions: SQL[] = [eq(event.engagementId, engagementId)];
  if (options.throughSeq !== undefined) conditions.push(lte(event.seq, options.throughSeq));
  if (options.recordedAtOrBefore !== undefined) conditions.push(lte(event.recordedAt, options.recordedAtOrBefore));
  return and(...conditions);
}

/** The engagement's events in seq order (the same query exports and verification use). */
export async function readEvents(tx: Tx, engagementId: string, options: ReadEventsOptions = {}): Promise<StoredEvent[]> {
  const rows = await tx.select().from(event).where(filters(engagementId, options)).orderBy(asc(event.seq));
  return rows.map(toStoredEvent);
}

/** Like `readEvents`, keeping each row's global id (for `event_note` and evidence lookups). */
export async function readEventRows(
  tx: Tx,
  engagementId: string,
  options: ReadEventsOptions = {},
): Promise<StoredEventRow[]> {
  const rows = await tx.select().from(event).where(filters(engagementId, options)).orderBy(asc(event.seq));
  return rows.map((row) => ({ id: row.id, event: toStoredEvent(row) }));
}
