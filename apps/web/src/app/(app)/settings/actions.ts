"use server";

import { revalidatePath } from "next/cache";
import { updateOrgSettings, type OrgSettingsPatch } from "@veradact/core";
import { runAction } from "@/lib/actions";
import { clock } from "@/lib/clock";
import { getDb } from "@/lib/db";
import type { FormState } from "@/lib/form-state";
import { requireAuth } from "@/lib/session";

function intOrNaN(value: FormDataEntryValue | null): number {
  const text = String(value ?? "").trim();
  return /^-?\d+$/.test(text) ? Number(text) : Number.NaN;
}

/** Admin only (core enforces it); the form submits every field. */
export async function updateSettingsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return runAction(async () => {
    const auth = await requireAuth();
    const retention = String(formData.get("retentionDays") ?? "").trim();
    const patch: OrgSettingsPatch = {
      aiEnabled: formData.get("aiEnabled") === "on",
      blockUnknownJurisdictions: formData.get("blockUnknownJurisdictions") === "on",
      retentionDays: retention === "" ? null : intOrNaN(retention),
      reminderBusinessDays: intOrNaN(formData.get("reminderBusinessDays")),
      allPartyStates: String(formData.get("allPartyStates") ?? "")
        .split(/[\s,]+/)
        .filter(Boolean),
    };
    await updateOrgSettings({ db: getDb(), ctx: auth, clock, patch });
    revalidatePath("/settings");
    return "Settings saved.";
  });
}
