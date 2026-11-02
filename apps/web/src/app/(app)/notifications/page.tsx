import type { Metadata } from "next";
import { EmptyState, PageHeader } from "@/components";

export const metadata: Metadata = { title: "Notifications" };

export default function NotificationsPage() {
  return (
    <>
      <PageHeader title="Notifications" description="Disputed items and declined authorizations." />
      <EmptyState title="No notifications" description="You'll see a notification here when a client disputes an item." />
    </>
  );
}
