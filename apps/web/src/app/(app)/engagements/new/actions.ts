"use server";

import { redirect } from "next/navigation";
import { createEngagement } from "@veradact/core";
import { runAction } from "@/lib/actions";
import { commandContext, field } from "@/lib/commands";
import type { FormState } from "@/lib/form-state";
import { chosenTimeZone } from "@/lib/time-zones";

export async function createEngagementAction(_prev: FormState, formData: FormData): Promise<FormState> {
  let engagementId: string | undefined;
  const state = await runAction(async () => {
    const ctx = await commandContext();
    const result = await createEngagement(ctx, {
      name: field(formData, "name"),
      clientName: field(formData, "clientName"),
      shortCode: field(formData, "shortCode").toUpperCase(),
      timeZone: chosenTimeZone(field(formData, "timeZone"), field(formData, "timeZoneOther")),
    });
    engagementId = result.engagementId;
  });
  if (engagementId) redirect(`/engagements/${engagementId}`);
  return state;
}
