// Contact erasure without breaking the chain (ARCHITECTURE §6, D-012): off-log rows and the
// contact's HMAC key are deleted; event rows are untouched, so the chain still verifies and the
// commitments in the log become unlinkable.
import { and, eq, isNull } from "drizzle-orm";
import { clientContact, confirmationEvidence, confirmationLink, contactPii, responseComment } from "@veradact/db";
import { writeAudit } from "../audit";
import type { EngagementState, StoredEvent } from "../domain";
import { DomainError } from "../errors";
import { appendEvents } from "../store";
import { fixedClock, lockAndLoad, runInTenant, userOrSystemActor, type UserOrSystemContext } from "./context";

/**
 * Deletes the contact's `contact_pii` (with its HMAC key), `confirmation_evidence` and
 * `response_comment` rows, nulls `sent_to_email` and revokes their links, sets
 * `client_contact.erased_at`, appends `contact_erased` and audits `contact.erase`.
 */
export async function eraseContact(
  ctx: UserOrSystemContext,
  input: { engagementId: string; contactId: string },
): Promise<{ events: StoredEvent[]; state: EngagementState }> {
  return runInTenant(ctx, async (tx) => {
    const { state } = await lockAndLoad(tx, input.engagementId);
    const [contact] = await tx
      .select({ id: clientContact.id, erasedAt: clientContact.erasedAt })
      .from(clientContact)
      .where(and(eq(clientContact.id, input.contactId), eq(clientContact.engagementId, input.engagementId)));
    if (!contact) throw new DomainError("contact_not_found", { contactId: input.contactId });
    if (contact.erasedAt !== null || state.erasedContacts.has(input.contactId)) throw new DomainError("contact_erased", { contactId: input.contactId });

    const now = ctx.clock();
    const appended = await appendEvents(
      tx,
      input.engagementId,
      [{ type: "contact_erased", actor: userOrSystemActor(ctx.userId), payload: { contact_id: input.contactId } }],
      { clock: fixedClock(now), state },
    );
    const erasedAt = appended.events[0]!.recordedAt;
    await tx.delete(confirmationEvidence).where(eq(confirmationEvidence.contactId, input.contactId));
    await tx.delete(responseComment).where(eq(responseComment.contactId, input.contactId));
    await tx.update(confirmationLink).set({ sentToEmail: null }).where(eq(confirmationLink.contactId, input.contactId));
    await tx
      .update(confirmationLink)
      .set({ revokedAt: erasedAt })
      .where(and(eq(confirmationLink.contactId, input.contactId), isNull(confirmationLink.revokedAt)));
    await tx.delete(contactPii).where(eq(contactPii.contactId, input.contactId));
    await tx.update(clientContact).set({ erasedAt }).where(eq(clientContact.id, input.contactId));
    await writeAudit(tx, {
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      action: "contact.erase",
      targetType: "contact",
      targetId: input.contactId,
      at: now,
    });
    return { events: appended.events, state: appended.state };
  });
}
