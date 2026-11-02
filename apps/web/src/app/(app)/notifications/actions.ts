"use server";

import { revalidatePath } from "next/cache";
import { markAllRead, markRead } from "@veradact/core";
import { clock } from "@/lib/clock";
import { withAuthTenant } from "@/lib/session";

/** Marks one of the user's notifications read (the nav badge counts unread ones). */
export async function markNotificationReadAction(formData: FormData): Promise<void> {
  const id = String(formData.get("notificationId") ?? "");
  await withAuthTenant((tx, auth) => markRead(tx, auth.userId, [id], clock()));
  revalidatePath("/", "layout");
}

export async function markAllNotificationsReadAction(): Promise<void> {
  await withAuthTenant((tx, auth) => markAllRead(tx, auth.userId, clock()));
  revalidatePath("/", "layout");
}
