// Confirmation channels (ARCHITECTURE §8.1, §15): how a contact is told about a request. The
// `email_link` channel emails a signed link; a future Slack channel implements the same interface
// and records responses through the same `recordClientResponses` (§8.4).
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import {
  appUser,
  confirmationLink,
  confirmationRequest,
  confirmationRequestItem,
  contactPii,
  engagement,
  org,
  withTenant,
  type Db,
  type Tx,
} from "@veradact/db";
import type { EmailProvider } from "@veradact/email";
import { requestConfirmation, type RequestConfirmationInput } from "../commands";
import type { ConfirmationChannelName } from "../domain";
import { log, logError, logId } from "../log";
import { confirmationLinkEmail } from "./emails";
import { clientLinkUrl, linkSigningSecret, signLinkToken } from "./link-token";

/** Everything a channel needs to tell one contact about one request. */
export interface ConfirmationDelivery {
  /** The first message for a request, or the single reminder (§8.6). */
  kind: "request" | "reminder";
  /** `${APP_URL}/c/<signed token>`. */
  url: string;
  link: { id: string; expiresAt: Date };
  contact: { id: string; name: string; email: string };
  request: { id: string; itemCount: number };
  engagement: { id: string; name: string; clientName: string; timeZone: string };
  vendorName: string;
  /** The member who sent the request (null if unknown). */
  requesterName: string | null;
}

export interface ConfirmationChannel {
  readonly name: ConfirmationChannelName;
  /** Delivers the link; throws when delivery failed. */
  deliver(delivery: ConfirmationDelivery): Promise<void>;
}

/** Emails the signed link (plain text + simple HTML, no tracking). */
export class EmailLinkChannel implements ConfirmationChannel {
  readonly name = "email_link" as const;
  readonly #emailProvider: EmailProvider;

  constructor(emailProvider: EmailProvider) {
    this.#emailProvider = emailProvider;
  }

  async deliver(delivery: ConfirmationDelivery): Promise<void> {
    await this.#emailProvider.send(confirmationLinkEmail(delivery));
  }
}

interface DeliveryTarget {
  linkId: string;
  contactId: string;
  expiresAt: Date;
  email: string | null;
  name: string | null;
}

export interface DeliveryContext {
  vendorName: string;
  requesterName: string | null;
  engagement: ConfirmationDelivery["engagement"];
  itemCount: number;
  targets: Map<string, DeliveryTarget>;
}

/** Names, engagement and link targets for delivering `linkIds` of one request (tenant tx). */
export async function loadDeliveryContext(tx: Tx, requestId: string, linkIds: readonly string[]): Promise<DeliveryContext | null> {
  const [req] = await tx
    .select({
      requestedBy: confirmationRequest.requestedBy,
      engagementId: confirmationRequest.engagementId,
      name: engagement.name,
      clientName: engagement.clientName,
      timeZone: engagement.timeZone,
      vendorName: org.name,
    })
    .from(confirmationRequest)
    .innerJoin(engagement, eq(engagement.id, confirmationRequest.engagementId))
    .innerJoin(org, eq(org.id, confirmationRequest.orgId))
    .where(eq(confirmationRequest.id, requestId));
  if (!req) return null;
  const [requester] = req.requestedBy
    ? await tx.select({ name: appUser.name }).from(appUser).where(eq(appUser.id, req.requestedBy))
    : [];
  const [items] = await tx.select({ n: count() }).from(confirmationRequestItem).where(eq(confirmationRequestItem.requestId, requestId));
  const rows = linkIds.length
    ? await tx
        .select({
          linkId: confirmationLink.id,
          contactId: confirmationLink.contactId,
          expiresAt: confirmationLink.expiresAt,
          email: confirmationLink.sentToEmail,
          name: contactPii.name,
        })
        .from(confirmationLink)
        .leftJoin(contactPii, eq(contactPii.contactId, confirmationLink.contactId))
        .where(and(eq(confirmationLink.requestId, requestId), inArray(confirmationLink.id, [...linkIds])))
    : [];
  return {
    vendorName: req.vendorName,
    requesterName: requester?.name ?? null,
    engagement: { id: req.engagementId, name: req.name, clientName: req.clientName, timeZone: req.timeZone },
    itemCount: Number(items?.n ?? 0),
    targets: new Map(rows.map((r) => [r.linkId, r])),
  };
}

/** Builds the delivery for one link, or null when the contact's address or name is gone (erased). */
export function buildDelivery(
  context: DeliveryContext,
  input: { kind: ConfirmationDelivery["kind"]; requestId: string; linkId: string; appUrl: string; secret: string },
): ConfirmationDelivery | null {
  const target = context.targets.get(input.linkId);
  if (!target || !target.email || !target.name) return null;
  const token = signLinkToken({ secret: input.secret, linkId: target.linkId, contactId: target.contactId, expiresAt: target.expiresAt });
  return {
    kind: input.kind,
    url: clientLinkUrl(input.appUrl, token),
    link: { id: target.linkId, expiresAt: target.expiresAt },
    contact: { id: target.contactId, name: target.name, email: target.email },
    request: { id: input.requestId, itemCount: context.itemCount },
    engagement: context.engagement,
    vendorName: context.vendorName,
    requesterName: context.requesterName,
  };
}

export interface SendConfirmationRequestInput extends RequestConfirmationInput {
  /** Public base URL of the web app (`APP_URL`). */
  appUrl: string;
  channel: ConfirmationChannel;
  /** Defaults to `LINK_SIGNING_SECRET`. */
  signingSecret?: string;
}

export interface LinkDeliveryResult {
  linkId: string;
  contactId: string;
  /** False when delivery failed: the request stands, the link has no `email_sent_at`. */
  sent: boolean;
}

export interface SendConfirmationRequestResult {
  requestId: string;
  deliveries: LinkDeliveryResult[];
  sentCount: number;
  failedCount: number;
}

/**
 * The member action "Send" (§8.1): `requestConfirmation` (event, links, audit) → a signed URL per
 * link → `channel.deliver` per contact → `email_sent_at`. A failed delivery keeps the request and
 * leaves that link without `email_sent_at` (reported in the result; the member can revoke and
 * resend). Delivery happens after the request is committed, never inside its transaction.
 */
export async function sendConfirmationRequest(
  ctx: { db: Db; orgId: string; userId: string; clock: () => Date },
  input: SendConfirmationRequestInput,
): Promise<SendConfirmationRequestResult> {
  const { appUrl, channel, signingSecret, ...request } = input;
  const secret = signingSecret ?? linkSigningSecret();
  const created = await requestConfirmation({ db: ctx.db, orgId: ctx.orgId, userId: ctx.userId, clock: ctx.clock }, request);
  const linkIds = created.links.map((l) => l.linkId);
  const context = await withTenant(ctx.db, { orgId: ctx.orgId, userId: ctx.userId }, (tx) =>
    loadDeliveryContext(tx, created.requestId, linkIds),
  );

  const deliveries: LinkDeliveryResult[] = [];
  for (const link of created.links) {
    const delivery = context ? buildDelivery(context, { kind: "request", requestId: created.requestId, linkId: link.linkId, appUrl, secret }) : null;
    let sent = false;
    if (delivery) {
      try {
        await channel.deliver(delivery);
        sent = true;
      } catch (error) {
        logError("confirmation.delivery_failed", error, { linkId: logId(link.linkId), requestId: logId(created.requestId) });
      }
    }
    if (sent) {
      const sentAt = ctx.clock();
      await withTenant(ctx.db, { orgId: ctx.orgId, userId: ctx.userId }, (tx) =>
        tx
          .update(confirmationLink)
          .set({ emailSentAt: sentAt })
          .where(and(eq(confirmationLink.id, link.linkId), isNull(confirmationLink.emailSentAt))),
      );
    }
    deliveries.push({ linkId: link.linkId, contactId: link.contactId, sent });
  }
  const sentCount = deliveries.filter((d) => d.sent).length;
  log.info("confirmation.sent", { requestId: logId(created.requestId), sent: sentCount, failed: deliveries.length - sentCount });
  return { requestId: created.requestId, deliveries, sentCount, failedCount: deliveries.length - sentCount };
}
