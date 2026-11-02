"use server";

import { revalidatePath } from "next/cache";
import { deactivateUser, inviteUser, type UserRole } from "@veradact/core";
import { runAction } from "@/lib/actions";
import { clock } from "@/lib/clock";
import { getDb } from "@/lib/db";
import { getEmailProvider } from "@/lib/email";
import { appUrl } from "@/lib/env";
import type { FormState } from "@/lib/form-state";
import { requireAuth } from "@/lib/session";

export async function inviteUserAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return runAction(async () => {
    const auth = await requireAuth();
    const { user, emailSent } = await inviteUser({
      db: getDb(),
      ctx: auth,
      clock,
      emailProvider: getEmailProvider(),
      appUrl: appUrl(),
      email: String(formData.get("email") ?? ""),
      name: String(formData.get("name") ?? ""),
      role: String(formData.get("role") ?? "") as UserRole,
    });
    revalidatePath("/settings/users");
    return emailSent
      ? `Added ${user.email}. They'll get an email explaining how to sign in.`
      : `Added ${user.email}, but the welcome email could not be sent. Ask them to sign in from the login page.`;
  });
}

export async function deactivateUserAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return runAction(async () => {
    const auth = await requireAuth();
    await deactivateUser({ db: getDb(), ctx: auth, clock, userId: String(formData.get("userId") ?? "") });
    revalidatePath("/settings/users");
    return "User deactivated.";
  });
}
