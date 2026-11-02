"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { acceptCandidate, rejectCandidate, type AcceptCandidateInput, type Kind } from "@veradact/core";
import { runAction } from "@/lib/actions";
import { commandContext, field } from "@/lib/commands";
import type { FormState } from "@/lib/form-state";
import { enumValue, KIND_LABELS } from "@/lib/labels";

/** Accept, or (with `mode=edit`) edit and accept. Redirects back with the new short id and any notes. */
export async function acceptCandidateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const engagementId = field(formData, "engagementId");
  let destination: string | undefined;
  const state = await runAction(async () => {
    const ctx = await commandContext();
    const input: AcceptCandidateInput = { candidateId: field(formData, "candidateId"), engagementId };
    if (field(formData, "mode") === "edit") {
      const kind = enumValue<Kind>(KIND_LABELS, field(formData, "kind"));
      input.edits = {
        statement: field(formData, "statement"),
        ...(kind ? { kind } : {}),
        dependsOn: field(formData, "dependsOn")
          .split(/[\s,]+/)
          .filter(Boolean),
      };
    }
    const result = await acceptCandidate(ctx, input);
    revalidatePath(`/engagements/${engagementId}`, "layout");
    const params = new URLSearchParams({ accepted: result.shortId, version: String(result.version) });
    // References typed into "Depends on" are echoed only when they look like ids (never free text in URLs).
    for (const note of result.notes) params.append("note", `${note.code}:${/^[A-Za-z0-9#-]{1,64}$/.test(note.ref) ? note.ref : "(reference)"}`);
    destination = `/engagements/${engagementId}/review?${params.toString()}`;
  });
  if (destination) redirect(destination);
  return state;
}

export async function rejectCandidateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return runAction(async () => {
    const ctx = await commandContext();
    const engagementId = field(formData, "engagementId");
    await rejectCandidate(ctx, { candidateId: field(formData, "candidateId"), engagementId });
    revalidatePath(`/engagements/${engagementId}/review`);
    return "Suggestion rejected.";
  });
}
