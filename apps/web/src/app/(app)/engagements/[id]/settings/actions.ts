"use server";

import { revalidatePath } from "next/cache";
import { archiveEngagement, isDomainError, reactivateEngagement, setClientEmailDomains, setEngagementAiEnabled, updateEngagement } from "@veradact/core";
import { runAction } from "@/lib/actions";
import { commandContext, field } from "@/lib/commands";
import type { FormState } from "@/lib/form-state";
import { chosenTimeZone } from "@/lib/time-zones";

function revalidateEngagement(engagementId: string): void {
  revalidatePath(`/engagements/${engagementId}`, "layout");
  revalidatePath("/engagements");
}

export async function updateEngagementAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return runAction(async () => {
    const ctx = await commandContext();
    const engagementId = field(formData, "engagementId");
    try {
      await updateEngagement(ctx, {
        engagementId,
        name: field(formData, "name"),
        clientName: field(formData, "clientName"),
        timeZone: chosenTimeZone(field(formData, "timeZone"), field(formData, "timeZoneOther")),
      });
    } catch (error) {
      if (isDomainError(error, "nothing_to_update")) return "No changes to save.";
      throw error;
    }
    revalidateEngagement(engagementId);
    return "Engagement updated.";
  });
}

/** Engagement AI switch (audited as `ai.toggle`; enforced server-side in runExtraction). */
export async function setEngagementAiAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return runAction(async () => {
    const ctx = await commandContext();
    const engagementId = field(formData, "engagementId");
    const enabled = field(formData, "enabled") === "true";
    await setEngagementAiEnabled(ctx, { engagementId, enabled });
    revalidateEngagement(engagementId);
    return enabled ? "AI suggestions turned on for this engagement." : "AI suggestions turned off. No source text from this engagement is sent to any model provider.";
  });
}

export async function setEngagementStatusAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return runAction(async () => {
    const ctx = await commandContext();
    const engagementId = field(formData, "engagementId");
    if (field(formData, "status") === "archived") await archiveEngagement(ctx, { engagementId });
    else await reactivateEngagement(ctx, { engagementId });
    revalidateEngagement(engagementId);
    return field(formData, "status") === "archived" ? "Engagement archived." : "Engagement reactivated.";
  });
}

/** Client email domains (D-057): contacts outside them need an audited acknowledgement. */
export async function setClientEmailDomainsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return runAction(async () => {
    const ctx = await commandContext();
    const engagementId = field(formData, "engagementId");
    const { domains } = await setClientEmailDomains(ctx, { engagementId, domains: field(formData, "domains") });
    revalidateEngagement(engagementId);
    return domains.length > 0 ? `Client email domains saved: ${domains.join(", ")}.` : "Client email domains cleared. Contacts can have any address.";
  });
}
