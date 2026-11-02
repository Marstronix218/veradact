// Command context for server actions: core commands run in the signed-in user's tenant.
import type { CommandContext } from "@veradact/core";
import type { Db } from "@veradact/db";
import { clock } from "./clock";
import { getDb } from "./db";
import { requireAuth } from "./session";

/** `{ db, orgId, userId, clock }` for the signed-in user (redirects to /login when signed out). */
export async function commandContext(): Promise<CommandContext & { db: Db }> {
  const auth = await requireAuth();
  return { db: getDb(), orgId: auth.orgId, userId: auth.userId, clock };
}

/** A trimmed string form field ("" when missing). */
export function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}
