// In-app notifications for vendor members (ARCHITECTURE §2.4, §8.5): a client disputed an item or
// declined authorization. Rows go to the member who sent the request; each member sees only their
// own. All functions run inside the caller's tenant transaction.
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { clientContact, contactPii, engagement, item, notification, type NotificationKind, type Tx } from "@veradact/db";
import { UUID_PATTERN } from "../domain";
import { ERASED_CONTACT_NAME } from "../queries";

export interface NewNotification {
  orgId: string;
  userId: string;
  engagementId: string;
  kind: NotificationKind;
  itemId: string | null;
  contactId: string | null;
  createdAt: Date;
}

export async function insertNotifications(tx: Tx, rows: readonly NewNotification[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(notification).values(rows.map((r) => ({ ...r, readAt: null })));
}

export interface NotificationView {
  id: string;
  kind: NotificationKind;
  engagementId: string;
  engagementName: string;
  /** For displaying `createdAt`. */
  engagementTimeZone: string;
  itemId: string | null;
  /** Short id of the item (e.g. `HALV-R7`), when the notification is about an item. */
  itemShortId: string | null;
  contactId: string | null;
  /** Contact name, or "Erased contact". */
  contactName: string | null;
  readAt: Date | null;
  createdAt: Date;
}

/** The user's notifications, newest first. */
export async function listNotifications(
  tx: Tx,
  userId: string,
  options: { limit?: number; unreadOnly?: boolean } = {},
): Promise<NotificationView[]> {
  const rows = await tx
    .select({
      id: notification.id,
      kind: notification.kind,
      engagementId: notification.engagementId,
      engagementName: engagement.name,
      engagementTimeZone: engagement.timeZone,
      itemId: notification.itemId,
      itemShortId: item.shortId,
      contactId: notification.contactId,
      contactErasedAt: clientContact.erasedAt,
      contactName: contactPii.name,
      readAt: notification.readAt,
      createdAt: notification.createdAt,
    })
    .from(notification)
    .innerJoin(engagement, eq(engagement.id, notification.engagementId))
    .leftJoin(item, eq(item.id, notification.itemId))
    .leftJoin(clientContact, eq(clientContact.id, notification.contactId))
    .leftJoin(contactPii, eq(contactPii.contactId, notification.contactId))
    .where(and(eq(notification.userId, userId), ...(options.unreadOnly ? [isNull(notification.readAt)] : [])))
    .orderBy(desc(notification.createdAt), desc(notification.id))
    .limit(options.limit ?? 200);
  return rows.map(({ contactErasedAt, contactName, ...r }) => ({
    ...r,
    contactName: r.contactId === null ? null : contactErasedAt !== null || contactName === null ? ERASED_CONTACT_NAME : contactName,
  }));
}

export async function unreadCount(tx: Tx, userId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(notification)
    .where(and(eq(notification.userId, userId), isNull(notification.readAt)));
  return Number(row?.n ?? 0);
}

/** Marks the user's notifications read (ids that are not theirs are ignored). Returns how many changed. */
export async function markRead(tx: Tx, userId: string, notificationIds: readonly string[], now: Date): Promise<number> {
  const ids = notificationIds.filter((id) => UUID_PATTERN.test(id));
  if (ids.length === 0) return 0;
  const rows = await tx
    .update(notification)
    .set({ readAt: now })
    .where(and(eq(notification.userId, userId), inArray(notification.id, ids), isNull(notification.readAt)))
    .returning({ id: notification.id });
  return rows.length;
}

export async function markAllRead(tx: Tx, userId: string, now: Date): Promise<number> {
  const rows = await tx
    .update(notification)
    .set({ readAt: now })
    .where(and(eq(notification.userId, userId), isNull(notification.readAt)))
    .returning({ id: notification.id });
  return rows.length;
}
