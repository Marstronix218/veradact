// One reminder per confirmation link (ARCHITECTURE §8.6): after `org.reminder_business_days`
// business days in the engagement time zone, to contacts who have not responded on that request,
// while at least one requested item is still pending at the requested version. Jobs list org ids
// through the definer function and do all work per org inside withTenant (§7).
//
// Exactly once: a link is claimed with `UPDATE … WHERE reminder_sent_at IS NULL RETURNING` and the
// claim commits before the email goes out, so concurrent runs cannot both send. A failed delivery
// releases the claim so the next run retries; a crash between claim and send loses that reminder
// (at most one, never two).
import { and, eq, exists, gt, isNotNull, isNull, notExists, sql } from "drizzle-orm";
import {
  clientContact,
  confirmationLink,
  confirmationRequest,
  confirmationRequestContact,
  confirmationRequestItem,
  contactPii,
  engagement,
  item,
  itemResponse,
  jobsListOrgIds,
  org,
  withTenant,
  type Db,
  type Tx,
} from "@veradact/db";
import type { EmailProvider } from "@veradact/email";
import { buildDelivery, EmailLinkChannel, linkSigningSecret, loadDeliveryContext, type ConfirmationChannel } from "../confirmation";
import { addBusinessDays } from "../domain";
import { log, logError, logId } from "../log";

export interface RunRemindersInput {
  db: Db;
  now: Date;
  emailProvider: EmailProvider;
  /** Public base URL of the web app (`APP_URL`). */
  appUrl: string;
  /** Defaults to `LINK_SIGNING_SECRET`. */
  signingSecret?: string;
  /** Defaults to the email link channel over `emailProvider`. */
  channel?: ConfirmationChannel;
  /** Limits the run to these orgs (tests share one database). Default: every org. */
  onlyOrgIds?: readonly string[];
}

export interface RunRemindersResult {
  orgs: number;
  /** Links past their reminder date that were checked. */
  due: number;
  sent: number;
  failed: number;
}

interface Candidate {
  linkId: string;
  requestId: string;
  emailSentAt: Date;
  timeZone: string;
}

/** Unreminded, unrevoked, unexpired links whose email was sent (one tenant). */
async function candidates(tx: Tx, now: Date): Promise<Candidate[]> {
  const rows = await tx
    .select({
      linkId: confirmationLink.id,
      requestId: confirmationLink.requestId,
      emailSentAt: confirmationLink.emailSentAt,
      timeZone: engagement.timeZone,
    })
    .from(confirmationLink)
    .innerJoin(engagement, eq(engagement.id, confirmationLink.engagementId))
    .where(
      and(
        isNotNull(confirmationLink.emailSentAt),
        isNull(confirmationLink.reminderSentAt),
        isNull(confirmationLink.revokedAt),
        gt(confirmationLink.expiresAt, now),
      ),
    );
  return rows.flatMap((r) => (r.emailSentAt ? [{ ...r, emailSentAt: r.emailSentAt }] : []));
}

/**
 * Claims the link if it still qualifies: request open for the contact (not revoked in the log, not
 * expired), contact not erased, no response from this contact on this request, and at least one
 * requested item active, pending and still at the requested version.
 */
async function claim(tx: Tx, linkId: string, now: Date): Promise<boolean> {
  const rows = await tx
    .update(confirmationLink)
    .set({ reminderSentAt: now })
    .where(
      and(
        eq(confirmationLink.id, linkId),
        isNull(confirmationLink.reminderSentAt),
        isNull(confirmationLink.revokedAt),
        gt(confirmationLink.expiresAt, now),
        exists(
          tx
            .select({ one: sql`1` })
            .from(confirmationRequestContact)
            .innerJoin(confirmationRequest, eq(confirmationRequest.id, confirmationRequestContact.requestId))
            .innerJoin(clientContact, eq(clientContact.id, confirmationRequestContact.contactId))
            .innerJoin(contactPii, eq(contactPii.contactId, confirmationRequestContact.contactId))
            .where(
              and(
                eq(confirmationRequestContact.requestId, confirmationLink.requestId),
                eq(confirmationRequestContact.contactId, confirmationLink.contactId),
                isNull(confirmationRequestContact.revokedAt),
                gt(confirmationRequest.expiresAt, now),
                isNull(clientContact.erasedAt),
              ),
            ),
        ),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(itemResponse)
            .where(and(eq(itemResponse.requestId, confirmationLink.requestId), eq(itemResponse.contactId, confirmationLink.contactId))),
        ),
        exists(
          tx
            .select({ one: sql`1` })
            .from(confirmationRequestItem)
            .innerJoin(item, eq(item.id, confirmationRequestItem.itemId))
            .where(
              and(
                eq(confirmationRequestItem.requestId, confirmationLink.requestId),
                eq(item.lifecycle, "active"),
                eq(item.status, "pending"),
                eq(item.currentVersion, confirmationRequestItem.version),
              ),
            ),
        ),
      ),
    )
    .returning({ id: confirmationLink.id });
  return rows.length === 1;
}

export async function runReminders(input: RunRemindersInput): Promise<RunRemindersResult> {
  const { db, now } = input;
  const secret = input.signingSecret ?? linkSigningSecret();
  const channel = input.channel ?? new EmailLinkChannel(input.emailProvider);
  const result: RunRemindersResult = { orgs: 0, due: 0, sent: 0, failed: 0 };

  const orgIds = (await jobsListOrgIds(db)).filter((id) => !input.onlyOrgIds || input.onlyOrgIds.includes(id));
  for (const orgId of orgIds) {
    result.orgs++;
    const claimed = await withTenant(db, { orgId }, async (tx) => {
      const [settings] = await tx.select({ days: org.reminderBusinessDays }).from(org).where(eq(org.id, orgId));
      const days = settings?.days ?? 2;
      const due = (await candidates(tx, now)).filter((c) => addBusinessDays(c.emailSentAt, days, c.timeZone).getTime() <= now.getTime());
      result.due += due.length;
      const out: { linkId: string; requestId: string }[] = [];
      for (const c of due) if (await claim(tx, c.linkId, now)) out.push({ linkId: c.linkId, requestId: c.requestId });
      return out;
    });

    for (const { linkId, requestId } of claimed) {
      let sent = false;
      try {
        const context = await withTenant(db, { orgId }, (tx) => loadDeliveryContext(tx, requestId, [linkId]));
        const delivery = context ? buildDelivery(context, { kind: "reminder", requestId, linkId, appUrl: input.appUrl, secret }) : null;
        if (delivery) {
          await channel.deliver(delivery);
          sent = true;
        }
      } catch (error) {
        logError("jobs.reminder.delivery_failed", error, { linkId: logId(linkId) });
      }
      if (sent) {
        result.sent++;
        continue;
      }
      result.failed++;
      await withTenant(db, { orgId }, (tx) =>
        tx
          .update(confirmationLink)
          .set({ reminderSentAt: null })
          .where(and(eq(confirmationLink.id, linkId), eq(confirmationLink.reminderSentAt, now))),
      );
    }
  }
  log.info("jobs.reminders", { orgs: result.orgs, due: result.due, sent: result.sent, failed: result.failed });
  return result;
}
