// Chain verification against the stored log and engagement_head (ARCHITECTURE §4).
import { eq } from "drizzle-orm";
import { engagementHead, type Tx } from "@veradact/db";
import { verifyChain, type ChainHead, type ChainVerification } from "../domain";
import { readEvents } from "./read-events";

/** The trigger-maintained head of the engagement's log, or null before genesis. */
export async function readEngagementHead(tx: Tx, engagementId: string): Promise<(ChainHead & { recordedAt: Date }) | null> {
  const [row] = await tx.select().from(engagementHead).where(eq(engagementHead.engagementId, engagementId));
  return row ? { seq: row.headSeq, hash: row.headHash, recordedAt: row.headRecordedAt } : null;
}

/**
 * `verifyChain(raw stored rows, engagement_head)`. Pass `expectedHead` to check against a head
 * printed in an earlier export or receipt instead of the stored one.
 *
 * The head is read BEFORE the events: at READ COMMITTED each statement sees the latest commits, and
 * the head only grows, so the events read afterwards always reach at least that head. Reading the
 * events first would report `truncated` whenever an append commits between the two reads.
 */
export async function verifyEngagementChain(
  tx: Tx,
  engagementId: string,
  expectedHead?: ChainHead | null,
): Promise<ChainVerification> {
  const head = expectedHead === undefined ? await readEngagementHead(tx, engagementId) : expectedHead;
  const rows = await readEvents(tx, engagementId);
  return verifyChain(rows, head ? { seq: head.seq, hash: head.hash } : null);
}
