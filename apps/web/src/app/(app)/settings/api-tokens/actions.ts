"use server";

import { revalidatePath } from "next/cache";
import { createApiToken, revokeApiToken } from "@veradact/core";
import { runAction } from "@/lib/actions";
import { clock } from "@/lib/clock";
import { getDb } from "@/lib/db";
import type { FormState } from "@/lib/form-state";
import { requireAuth } from "@/lib/session";

export interface CreateTokenState extends FormState {
  /** The raw token, returned once and never stored by the app. */
  token?: string;
  name?: string;
}

export async function createApiTokenAction(_prev: CreateTokenState, formData: FormData): Promise<CreateTokenState> {
  let created: { token: string; name: string } | undefined;
  const state = await runAction(async () => {
    const auth = await requireAuth();
    created = await createApiToken({ db: getDb(), ctx: auth, clock, name: String(formData.get("name") ?? "") });
    revalidatePath("/settings/api-tokens");
    return "Token created.";
  });
  return created ? { ...state, token: created.token, name: created.name } : state;
}

export async function revokeApiTokenAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return runAction(async () => {
    const auth = await requireAuth();
    await revokeApiToken({ db: getDb(), ctx: auth, clock, tokenId: String(formData.get("tokenId") ?? "") });
    revalidatePath("/settings/api-tokens");
    return "Token revoked.";
  });
}
