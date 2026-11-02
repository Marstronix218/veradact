// Vendor-side reads for the confirmations page (ARCHITECTURE §8.5, §13): open disputes with the
// client's comment, so the member can revise or withdraw the item.
import { and, asc, eq, inArray } from "drizzle-orm";
import { clientContact, contactPii, event, item, itemResponse, itemVersion, responseComment, type Tx } from "@veradact/db";
import type { Kind } from "../domain";
import { compareItemRows, ERASED_CONTACT_NAME } from "../queries";

export interface OpenDispute {
  itemId: string;
  shortId: string;
  kind: Kind;
  version: number;
  statement: string;
  contactId: string;
  /** Contact name, or "Erased contact". */
  contactName: string;
  /** Null when erased with the contact. */
  comment: string | null;
  recordedAt: Date;
}

/**
 * Active disputed items with every contact whose latest response to the current version is a
 * dispute (D-009), in ledger order.
 */
export async function listOpenDisputes(tx: Tx, engagementId: string): Promise<OpenDispute[]> {
  const items = await tx
    .select({ id: item.id, shortId: item.shortId, kind: item.kind, currentVersion: item.currentVersion, contentHash: itemVersion.contentHash, statement: itemVersion.statement })
    .from(item)
    .innerJoin(itemVersion, and(eq(itemVersion.itemId, item.id), eq(itemVersion.version, item.currentVersion)))
    .where(and(eq(item.engagementId, engagementId), eq(item.status, "disputed"), eq(item.lifecycle, "active")));
  if (items.length === 0) return [];

  const responses = await tx
    .select()
    .from(itemResponse)
    .where(and(eq(itemResponse.engagementId, engagementId), inArray(itemResponse.itemId, items.map((i) => i.id))))
    .orderBy(asc(itemResponse.eventSeq));
  const latest = new Map<string, (typeof responses)[number]>();
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const r of responses) {
    const it = byId.get(r.itemId);
    if (it && r.version === it.currentVersion && r.contentHash === it.contentHash) latest.set(`${r.itemId}:${r.contactId}`, r);
  }
  const disputes = [...latest.values()].filter((r) => r.response === "disputed");
  if (disputes.length === 0) return [];

  const [events, contacts] = await Promise.all([
    tx
      .select({ seq: event.seq, comment: responseComment.comment })
      .from(event)
      .innerJoin(responseComment, eq(responseComment.eventId, event.id))
      .where(and(eq(event.engagementId, engagementId), inArray(event.seq, disputes.map((d) => d.eventSeq)))),
    tx
      .select({ id: clientContact.id, erasedAt: clientContact.erasedAt, name: contactPii.name })
      .from(clientContact)
      .leftJoin(contactPii, eq(contactPii.contactId, clientContact.id))
      .where(inArray(clientContact.id, [...new Set(disputes.map((d) => d.contactId))])),
  ]);
  const commentBySeq = new Map(events.map((e) => [e.seq, e.comment]));
  const contactById = new Map(contacts.map((c) => [c.id, c]));

  return disputes
    .map((d) => {
      const it = byId.get(d.itemId)!;
      const contact = contactById.get(d.contactId);
      const erased = !contact || contact.erasedAt !== null || contact.name === null;
      return {
        itemId: it.id,
        shortId: it.shortId,
        kind: it.kind,
        version: it.currentVersion,
        statement: it.statement,
        contactId: d.contactId,
        contactName: erased ? ERASED_CONTACT_NAME : contact.name!,
        comment: commentBySeq.get(d.eventSeq) ?? null,
        recordedAt: d.recordedAt,
      };
    })
    .sort((a, b) => compareItemRows(a, b) || a.recordedAt.getTime() - b.recordedAt.getTime());
}
