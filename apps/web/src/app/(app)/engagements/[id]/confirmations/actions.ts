"use server";

import { revalidatePath } from "next/cache";
import { EmailLinkChannel, revokeConfirmation, sendConfirmationRequest, UUID_PATTERN, ValidationError } from "@veradact/core";
import { runAction } from "@/lib/actions";
import { clock } from "@/lib/clock";
import { getDb } from "@/lib/db";
import { getEmailProvider } from "@/lib/email";
import { appUrl } from "@/lib/env";
import type { FormState } from "@/lib/form-state";
import { requireAuth } from "@/lib/session";
import { EXPIRY_DAYS } from "./constants";

const DAY_MS = 86_400_000;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function engagementIdFrom(formData: FormData): string {
  const id = String(formData.get("engagementId") ?? "");
  if (!UUID_PATTERN.test(id)) throw new ValidationError("Unknown engagement.", "engagementId");
  return id;
}

/** "Send": creates the request (audited), emails each contact a signed link. */
export async function sendConfirmationRequestAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return runAction(async () => {
    const auth = await requireAuth();
    const engagementId = engagementIdFrom(formData);
    // Each item value is "<item id>:<version>:<content hash>", the version the member saw.
    const items = formData
      .getAll("item")
      .map((v) => String(v).split(":"))
      .filter((parts) => parts.length === 3 && UUID_PATTERN.test(parts[0]!) && /^\d+$/.test(parts[1]!))
      .map(([itemId, version, contentHash]) => ({ itemId: itemId!, version: Number(version), contentHash: contentHash! }));
    const contactIds = formData.getAll("contact").map(String).filter((id) => UUID_PATTERN.test(id));
    if (items.length === 0) throw new ValidationError("Choose at least one item to send.", "item");
    if (contactIds.length === 0) throw new ValidationError("Choose at least one contact.", "contact");
    const days = Number(String(formData.get("expiresInDays") ?? EXPIRY_DAYS.default));
    if (!Number.isInteger(days) || days < EXPIRY_DAYS.min || days > EXPIRY_DAYS.max) {
      throw new ValidationError(`The link must expire in ${EXPIRY_DAYS.min} to ${EXPIRY_DAYS.max} days.`, "expiresInDays");
    }

    const result = await sendConfirmationRequest(
      { db: getDb(), orgId: auth.orgId, userId: auth.userId, clock },
      {
        engagementId,
        items,
        contactIds,
        expiresAt: new Date(clock().getTime() + days * DAY_MS),
        appUrl: appUrl(),
        channel: new EmailLinkChannel(getEmailProvider()),
      },
    );
    revalidatePath(`/engagements/${engagementId}/confirmations`);
    const sent = `${plural(items.length, "item", "items")} sent to ${plural(result.sentCount, "contact", "contacts")}.`;
    return result.failedCount === 0
      ? sent
      : `Request created. ${sent} The email to ${plural(result.failedCount, "contact", "contacts")} could not be delivered; revoke that link and send again.`;
  });
}

/** Revokes one contact's link, or the whole request when no contact is given. */
export async function revokeConfirmationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return runAction(async () => {
    const auth = await requireAuth();
    const engagementId = engagementIdFrom(formData);
    const requestId = String(formData.get("requestId") ?? "");
    const contactId = String(formData.get("contactId") ?? "");
    if (!UUID_PATTERN.test(requestId)) throw new ValidationError("Unknown request.", "requestId");
    if (contactId !== "" && !UUID_PATTERN.test(contactId)) throw new ValidationError("Unknown contact.", "contactId");
    await revokeConfirmation(
      { db: getDb(), orgId: auth.orgId, userId: auth.userId, clock },
      { engagementId, requestId, contactId: contactId === "" ? null : contactId },
    );
    revalidatePath(`/engagements/${engagementId}/confirmations`);
    return contactId === "" ? "Request revoked. Its links no longer work." : "Link revoked.";
  });
}
