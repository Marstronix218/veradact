import type { Metadata } from "next";
import Link from "next/link";
import { formatDateTime, listNotifications, type NotificationView } from "@veradact/core";
import { Badge, Button, EmptyState, PageHeader } from "@/components";
import { withAuthTenant } from "@/lib/session";
import { markAllNotificationsReadAction, markNotificationReadAction } from "./actions";

export const metadata: Metadata = { title: "Notifications" };

function describe(n: NotificationView): string {
  const who = n.contactName ?? "A client contact";
  return n.kind === "item_disputed"
    ? `${who} disputed ${n.itemShortId ?? "an item"} in ${n.engagementName}.`
    : `${who} declined the authorization for ${n.engagementName} and cannot confirm items.`;
}

function target(n: NotificationView): { href: string; label: string } {
  return n.kind === "item_disputed" && n.itemId
    ? { href: `/engagements/${n.engagementId}/items/${n.itemId}`, label: "Open item" }
    : { href: `/engagements/${n.engagementId}/confirmations`, label: "Open confirmations" };
}

export default async function NotificationsPage() {
  const notifications = await withAuthTenant((tx, auth) => listNotifications(tx, auth.userId));
  const unread = notifications.filter((n) => n.readAt === null).length;

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Disputed items and declined authorizations on requests you sent."
        actions={
          unread > 0 ? (
            <form action={markAllNotificationsReadAction}>
              <Button type="submit" variant="secondary">
                Mark all as read
              </Button>
            </form>
          ) : null
        }
      />
      {notifications.length === 0 ? (
        <EmptyState title="No notifications" description="You'll see a notification here when a client disputes an item or declines authorization." />
      ) : (
        <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white" data-testid="notifications">
          {notifications.map((n) => {
            const link = target(n);
            return (
              <li key={n.id} className={`flex flex-wrap items-center gap-3 px-4 py-3 ${n.readAt ? "" : "bg-amber-50/40"}`} data-testid="notification">
                <Badge tone={n.kind === "item_disputed" ? "red" : "yellow"}>{n.kind === "item_disputed" ? "Disputed" : "Declined"}</Badge>
                <div className="min-w-0 flex-1">
                  <p className={`text-sm ${n.readAt ? "text-zinc-700" : "font-medium text-zinc-900"}`}>{describe(n)}</p>
                  <p className="text-xs text-zinc-500">{formatDateTime(n.createdAt, n.engagementTimeZone)}</p>
                </div>
                <Link href={link.href} className="text-sm underline">
                  {link.label}
                </Link>
                {n.readAt ? (
                  <span className="text-xs text-zinc-500">Read</span>
                ) : (
                  <form action={markNotificationReadAction}>
                    <input type="hidden" name="notificationId" value={n.id} />
                    <Button type="submit" variant="secondary" size="sm">
                      Mark as read
                    </Button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
