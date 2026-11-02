// Confirmation request read helpers with per-contact link status (ARCHITECTURE §8, §13).
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  clientContact,
  confirmationLink,
  confirmationRequest,
  confirmationRequestContact,
  confirmationRequestItem,
  contactPii,
  item,
  itemResponse,
  itemVersion,
  type Tx,
} from "@veradact/db";
import type { ItemLifecycle, ItemStatus, Kind, ResponseDecision } from "../domain";
import { compareItemRows, ERASED_CONTACT_NAME } from "./items";

export type LinkStatus = "revoked" | "responded" | "expired" | "interacted" | "opened" | "sent" | "not_sent";

export interface RequestItemRow {
  itemId: string;
  shortId: string;
  kind: Kind;
  /** The requested version and its content. */
  version: number;
  contentHash: string;
  statement: string;
  currentVersion: number;
  currentStatus: ItemStatus;
  lifecycle: ItemLifecycle;
  /** Revised, superseded or withdrawn since the request ("updated since this request"). */
  changedSinceRequest: boolean;
}

export interface RequestContactRow {
  contactId: string;
  contactName: string;
  contactErased: boolean;
  revokedAt: Date | null;
  linkId: string | null;
  linkStatus: LinkStatus;
  emailSentAt: Date | null;
  reminderSentAt: Date | null;
  firstOpenedAt: Date | null;
  openCount: number;
  firstInteractionAt: Date | null;
  /** Latest response per item from this contact on this request. */
  responses: { itemId: string; version: number; response: ResponseDecision; recordedAt: Date }[];
}

export interface ConfirmationRequestView {
  id: string;
  requestedBy: string;
  recordedAt: Date;
  expiresAt: Date;
  expired: boolean;
  eventSeq: number;
  items: RequestItemRow[];
  contacts: RequestContactRow[];
}

/** Confirmation requests of the engagement, newest first (or one request with `requestId`). */
export async function listConfirmationRequests(
  tx: Tx,
  engagementId: string,
  options: { now: Date; requestId?: string },
): Promise<ConfirmationRequestView[]> {
  const requests = await tx
    .select()
    .from(confirmationRequest)
    .where(and(eq(confirmationRequest.engagementId, engagementId), ...(options.requestId ? [eq(confirmationRequest.id, options.requestId)] : [])))
    .orderBy(desc(confirmationRequest.eventSeq));
  if (requests.length === 0) return [];
  const requestIds = requests.map((r) => r.id);

  const [items, contacts, links, responses] = await Promise.all([
    tx
      .select({
        requestId: confirmationRequestItem.requestId,
        itemId: confirmationRequestItem.itemId,
        version: confirmationRequestItem.version,
        contentHash: confirmationRequestItem.contentHash,
        statement: itemVersion.statement,
        shortId: item.shortId,
        kind: item.kind,
        currentVersion: item.currentVersion,
        currentStatus: item.status,
        lifecycle: item.lifecycle,
      })
      .from(confirmationRequestItem)
      .innerJoin(item, eq(item.id, confirmationRequestItem.itemId))
      .innerJoin(itemVersion, and(eq(itemVersion.itemId, confirmationRequestItem.itemId), eq(itemVersion.version, confirmationRequestItem.version)))
      .where(inArray(confirmationRequestItem.requestId, requestIds)),
    tx
      .select({
        requestId: confirmationRequestContact.requestId,
        contactId: confirmationRequestContact.contactId,
        revokedAt: confirmationRequestContact.revokedAt,
        erasedAt: clientContact.erasedAt,
        name: contactPii.name,
      })
      .from(confirmationRequestContact)
      .leftJoin(clientContact, eq(clientContact.id, confirmationRequestContact.contactId))
      .leftJoin(contactPii, eq(contactPii.contactId, confirmationRequestContact.contactId))
      .where(inArray(confirmationRequestContact.requestId, requestIds))
      .orderBy(asc(confirmationRequestContact.contactId)),
    tx.select().from(confirmationLink).where(inArray(confirmationLink.requestId, requestIds)).orderBy(asc(confirmationLink.createdAt)),
    tx
      .select()
      .from(itemResponse)
      .where(and(eq(itemResponse.engagementId, engagementId), inArray(itemResponse.requestId, requestIds)))
      .orderBy(asc(itemResponse.eventSeq)),
  ]);

  const now = options.now.getTime();
  return requests.map((req) => {
    const expired = req.expiresAt.getTime() <= now;
    const requestItems = items
      .filter((i) => i.requestId === req.id)
      .map(({ requestId: _requestId, ...i }) => ({ ...i, changedSinceRequest: i.currentVersion !== i.version || i.lifecycle !== "active" }))
      .sort(compareItemRows);
    const requestContacts = contacts
      .filter((c) => c.requestId === req.id)
      .map((c) => {
        const link = links.filter((l) => l.requestId === req.id && l.contactId === c.contactId).at(-1) ?? null;
        const latest = new Map<string, { itemId: string; version: number; response: ResponseDecision; recordedAt: Date }>();
        for (const r of responses) {
          if (r.requestId === req.id && r.contactId === c.contactId) {
            latest.set(r.itemId, { itemId: r.itemId, version: r.version, response: r.response, recordedAt: r.recordedAt });
          }
        }
        const erased = c.erasedAt !== null || c.name === null;
        const revokedAt = c.revokedAt ?? link?.revokedAt ?? null;
        const status: LinkStatus =
          revokedAt !== null
            ? "revoked"
            : latest.size > 0
              ? "responded"
              : expired || (link !== null && link.expiresAt.getTime() <= now)
                ? "expired"
                : link?.firstInteractionAt
                  ? "interacted"
                  : link?.firstOpenedAt
                    ? "opened"
                    : link?.emailSentAt
                      ? "sent"
                      : "not_sent";
        return {
          contactId: c.contactId,
          contactName: erased ? ERASED_CONTACT_NAME : c.name!,
          contactErased: erased,
          revokedAt,
          linkId: link?.id ?? null,
          linkStatus: status,
          emailSentAt: link?.emailSentAt ?? null,
          reminderSentAt: link?.reminderSentAt ?? null,
          firstOpenedAt: link?.firstOpenedAt ?? null,
          openCount: link?.openCount ?? 0,
          firstInteractionAt: link?.firstInteractionAt ?? null,
          responses: [...latest.values()],
        };
      });
    return {
      id: req.id,
      requestedBy: req.requestedBy,
      recordedAt: req.recordedAt,
      expiresAt: req.expiresAt,
      expired,
      eventSeq: req.eventSeq,
      items: requestItems,
      contacts: requestContacts,
    };
  });
}
