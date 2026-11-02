// The engagement record from the stored log (ARCHITECTURE §6, §10): raw events verified against
// `engagement_head`, and each response's evidence commitment re-checked against its snapshot.
import { eq } from "drizzle-orm";
import { clientContact, confirmationEvidence, contactPii, event, responseComment, type Tx } from "@veradact/db";
import { evidenceCommitment, readEngagementHead, readEventRows, timingSafeEqualHex } from "@veradact/core";
import type { ExportContext } from "../context";
import { buildRecordExport, type EvidenceStatus, type RecordExport } from "../record";
import { loadExportContext } from "./context";

export interface LoadRecordInput {
  engagementId: string;
  clock: () => Date;
}

export interface LoadedRecord {
  record: RecordExport;
  ctx: ExportContext;
}

/**
 * Full log (raw stored values), `engagement_head` (read first) as the expected head, evidence
 * statuses (`verified` / `mismatch` / `erased` / `missing`) of responses and authorizations, and
 * dispute comments (null once erased).
 */
export async function loadRecord(tx: Tx, input: LoadRecordInput): Promise<LoadedRecord> {
  const { engagementId } = input;
  const loaded = await loadExportContext(tx, { engagementId, clock: input.clock, asOf: null });
  // The head is read BEFORE the events (as in `verifyEngagementChain`): the head only grows, so the
  // events read afterwards reach at least that head even if a submission commits in between. The
  // other way round, such an append would make an untampered log look `truncated`.
  const head = await readEngagementHead(tx, engagementId);
  const ctx: ExportContext = head ? { ...loaded, head: { seq: head.seq, hash: head.hash } } : loaded;
  const [rows, evidenceRows, commentRows, contacts] = await Promise.all([
    readEventRows(tx, engagementId),
    tx
      .select({ evidence: confirmationEvidence })
      .from(confirmationEvidence)
      .innerJoin(event, eq(event.id, confirmationEvidence.eventId))
      .where(eq(event.engagementId, engagementId)),
    tx
      .select({ eventId: responseComment.eventId, comment: responseComment.comment })
      .from(responseComment)
      .innerJoin(event, eq(event.id, responseComment.eventId))
      .where(eq(event.engagementId, engagementId)),
    tx
      .select({ id: clientContact.id, erasedAt: clientContact.erasedAt, hmacKey: contactPii.hmacKey })
      .from(clientContact)
      .leftJoin(contactPii, eq(contactPii.contactId, clientContact.id))
      .where(eq(clientContact.engagementId, engagementId)),
  ]);

  const bySeq = new Map(rows.map((r) => [r.event.seq, r]));
  const evidenceByEvent = new Map(evidenceRows.map((r) => [r.evidence.eventId, r.evidence]));
  const commentByEvent = new Map(commentRows.map((r) => [r.eventId, r.comment]));
  const keyByContact = new Map(contacts.map((c) => [c.id, c.erasedAt === null ? c.hmacKey : null]));
  const isErased = (contactId: string) => keyByContact.has(contactId) && keyByContact.get(contactId) === null;

  const evidenceFor = (seq: number, contactId: string): EvidenceStatus => {
    if (isErased(contactId)) return "erased";
    const row = bySeq.get(seq);
    const evidence = row ? evidenceByEvent.get(row.id) : undefined;
    const key = keyByContact.get(contactId);
    if (!row || !evidence || !key) return "missing";
    const payload = row.event.payload as { evidence_commitment?: unknown };
    if (evidence.contactId !== contactId || typeof payload.evidence_commitment !== "string") return "mismatch";
    const recomputed = evidenceCommitment({ hmacKey: key, name: evidence.name, email: evidence.email }, { ip: evidence.ip, userAgent: evidence.userAgent });
    return timingSafeEqualHex(recomputed, payload.evidence_commitment) ? "verified" : "mismatch";
  };

  const commentFor = (seq: number): string | null | undefined => {
    const row = bySeq.get(seq);
    const comment = row ? commentByEvent.get(row.id) : undefined;
    if (comment !== undefined) return comment;
    const contactId = (row?.event.payload as { contact_id?: unknown } | undefined)?.contact_id;
    return typeof contactId === "string" && isErased(contactId) ? null : undefined;
  };

  const record = buildRecordExport(
    rows.map((r) => r.event),
    { evidenceFor, commentFor, expectedHead: head ? { seq: head.seq, hash: head.hash } : null },
  );
  return { record, ctx };
}
