"use server";

import { revalidatePath } from "next/cache";
import { addContact, eraseContact, ValidationError } from "@veradact/core";
import { runAction } from "@/lib/actions";
import { commandContext, field } from "@/lib/commands";
import type { FormState } from "@/lib/form-state";

export async function addContactAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return runAction(async () => {
    const ctx = await commandContext();
    const engagementId = field(formData, "engagementId");
    await addContact(ctx, { engagementId, name: field(formData, "name"), email: field(formData, "email"), title: field(formData, "title") || null });
    revalidatePath(`/engagements/${engagementId}/contacts`);
    return "Contact added.";
  });
}

export async function eraseContactAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return runAction(async () => {
    const ctx = await commandContext();
    const engagementId = field(formData, "engagementId");
    if (formData.get("understood") !== "on") throw new ValidationError("Confirm that you understand the erasure cannot be undone.", "understood");
    await eraseContact(ctx, { engagementId, contactId: field(formData, "contactId") });
    revalidatePath(`/engagements/${engagementId}`, "layout");
    return "Contact erased.";
  });
}
