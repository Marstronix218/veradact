// Client actions on a resolved link (ARCHITECTURE §8.3–§8.5): open/interaction tracking, the
// written authorization (grant/decline, D-019) and the response submission (D-020, D-029). Every
// ledger write goes through the channel-agnostic commands (`recordAuthorization`,
// `recordClientResponses`); this module adds the authorization-text version check, notifications
// and emails. Emails are sent after the transaction commits and never fail the action.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  appUser,
  confirmationLink,
  confirmationRequest,
  contactAuthorization,
  contactPii,
  engagement,
  event,
  org,
  responseComment,
  withTenant,
  type Db,
  type Tx,
} from "@veradact/db";
import type { EmailMessage, EmailProvider } from "@veradact/email";
import { recordAuthorization, recordClientResponses, submissionOwner, COMMENT_MAX, type ClientEvidence } from "../commands";
import { UUID_PATTERN, sha256Hex, type EngagementState, type Kind, type ResponseDecision } from "../domain";
import { DomainError, isDomainError } from "../errors";
import { logError, logId } from "../log";
import { insertNotifications } from "../notifications";
import { compareItemRows } from "../queries";
import { checkRateLimit, type RateLimitResult } from "../security/rate-limit";
import { loadState, lockEngagement } from "../store";
import { AUTHORIZATION_TEXT_VERSION, renderAuthorizationText } from "./authorization-text";
import { declineNotificationEmail, disputeNotificationEmail, receiptEmail } from "./emails";
import type { ClientLinkContext } from "./link-token";

/** Fixed windows for the public client page (ARCHITECTURE §14). */
export const CLIENT_PAGE_RATE_LIMITS = {
  perIp: { limit: 300, windowSeconds: 15 * 60 },
  perLink: { limit: 120, windowSeconds: 15 * 60 },
} as const;

/**
 * Counts one client-page request per IP and per link (the link id parsed from the token, or the
 * token itself when malformed — both hashed before storage). Returns the first limit hit, if any.
 */
export async function checkClientPageRateLimit(
  db: Db,
  input: { ip: string; linkKey: string; now: Date },
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  const byIp: RateLimitResult = await checkRateLimit(db, { scope: "client_page_ip", id: input.ip, now: input.now, ...CLIENT_PAGE_RATE_LIMITS.perIp });
  if (!byIp.allowed) return { allowed: false, retryAfterSeconds: byIp.retryAfterSeconds };
  const byLink = await checkRateLimit(db, { scope: "client_page_link", id: input.linkKey, now: input.now, ...CLIENT_PAGE_RATE_LIMITS.perLink });
  if (!byLink.allowed) return { allowed: false, retryAfterSeconds: byLink.retryAfterSeconds };
  return { allowed: true };
}

export interface ClientLinkHandle {
  db: Db;
  link: ClientLinkContext;
  clock: () => Date;
}

/** GET of the client page: raw open counter (inflated by mail scanners, D-028). */
export async function recordLinkOpen({ db, link, clock }: ClientLinkHandle): Promise<void> {
  const now = clock();
  await withTenant(db, { orgId: link.orgId }, (tx) =>
    tx
      .update(confirmationLink)
      .set({
        openCount: sql`${confirmationLink.openCount} + 1`,
        firstOpenedAt: sql`coalesce(${confirmationLink.firstOpenedAt}, ${now})`,
        lastOpenedAt: now,
      })
      .where(eq(confirmationLink.id, link.linkId)),
  );
}

/** First POST of any kind: the link-engagement metric (§12). */
export async function recordLinkInteraction({ db, link, clock }: ClientLinkHandle): Promise<void> {
  const now = clock();
  await withTenant(db, { orgId: link.orgId }, (tx) =>
    tx
      .update(confirmationLink)
      .set({ firstInteractionAt: now })
      .where(and(eq(confirmationLink.id, link.linkId), isNull(confirmationLink.firstInteractionAt))),
  );
}

interface Requester {
  userId: string;
  name: string;
  email: string;
  active: boolean;
}

interface LinkNames {
  vendorName: string;
  engagementName: string;
  clientName: string;
  timeZone: string;
  contactName: string;
  contactEmail: string;
  requester: Requester | null;
}

async function loadLinkNames(tx: Tx, link: ClientLinkContext): Promise<LinkNames> {
  const [row] = await tx
    .select({
      vendorName: org.name,
      engagementName: engagement.name,
      clientName: engagement.clientName,
      timeZone: engagement.timeZone,
      requestedBy: confirmationRequest.requestedBy,
    })
    .from(confirmationRequest)
    .innerJoin(engagement, eq(engagement.id, confirmationRequest.engagementId))
    .innerJoin(org, eq(org.id, confirmationRequest.orgId))
    .where(eq(confirmationRequest.id, link.requestId));
  const [contact] = await tx.select({ name: contactPii.name, email: contactPii.email }).from(contactPii).where(eq(contactPii.contactId, link.contactId));
  // Both exist for a resolved link unless the contact was erased (or the request removed) since.
  if (!row) throw new DomainError("request_not_found", { requestId: link.requestId });
  if (!contact) throw new DomainError("contact_erased", { contactId: link.contactId });
  const [user] = await tx
    .select({ id: appUser.id, name: appUser.name, email: appUser.email, deactivatedAt: appUser.deactivatedAt })
    .from(appUser)
    .where(eq(appUser.id, row.requestedBy));
  return {
    vendorName: row.vendorName,
    engagementName: row.engagementName,
    clientName: row.clientName,
    timeZone: row.timeZone,
    contactName: contact.name,
    contactEmail: contact.email,
    requester: user ? { userId: user.id, name: user.name, email: user.email, active: user.deactivatedAt === null } : null,
  };
}

async function sendQuietly(emailProvider: EmailProvider, message: EmailMessage, event: string, link: ClientLinkContext): Promise<boolean> {
  try {
    await emailProvider.send(message);
    return true;
  } catch (error) {
    logError(event, error, { linkId: logId(link.linkId), requestId: logId(link.requestId) });
    return false;
  }
}

function confirmationsUrl(appUrl: string, engagementId: string): string {
  return `${appUrl.replace(/\/+$/, "")}/engagements/${engagementId}/confirmations`;
}

// ---------------------------------------------------------------------------------------------
// Authorization

export interface ClientAuthorizeInput extends ClientLinkHandle {
  decision: "granted" | "declined";
  /**
   * sha256 of the authorization text the contact was shown (hidden form field). When it differs
   * from the text rendered now (names changed in between), nothing is recorded and the contact is
   * shown the new text.
   */
  shownTextSha256: string | null;
  evidence: ClientEvidence;
  emailProvider: EmailProvider;
  appUrl: string;
}

export type ClientAuthorizeResult =
  | { status: "recorded"; decision: "granted" | "declined" }
  | { status: "text_changed" }
  /** The request was revoked or expired, or the contact erased, since the link was resolved. Nothing was recorded. */
  | { status: "stale" };

/**
 * Records the contact's decision with the exact rendered text and its version (D-019). A decline
 * notifies the member who sent the request (notification row in the same transaction + email).
 * Rule violations from races answer `stale` instead of throwing, like `clientSubmit`.
 */
export async function clientAuthorize(input: ClientAuthorizeInput): Promise<ClientAuthorizeResult> {
  const { db, link, clock } = input;
  let outcome: { changed: boolean; names: LinkNames };
  try {
    outcome = await withTenant(db, { orgId: link.orgId }, async (tx) => {
      const names = await loadLinkNames(tx, link);
      const text = renderAuthorizationText({ vendorName: names.vendorName, engagementName: names.engagementName, clientName: names.clientName });
      if (input.shownTextSha256 !== null && input.shownTextSha256 !== sha256Hex(text)) return { changed: true as const, names };
      const result = await recordAuthorization(
        { tx, orgId: link.orgId, clock },
        {
          engagementId: link.engagementId,
          requestId: link.requestId,
          contactId: link.contactId,
          decision: input.decision,
          text,
          textVersion: AUTHORIZATION_TEXT_VERSION,
          evidence: input.evidence,
        },
      );
      if (input.decision === "declined" && names.requester) {
        await insertNotifications(tx, [
          {
            orgId: link.orgId,
            userId: names.requester.userId,
            engagementId: link.engagementId,
            kind: "authorization_declined",
            itemId: null,
            contactId: link.contactId,
            createdAt: result.events[0]!.recordedAt,
          },
        ]);
      }
      return { changed: false as const, names };
    });
  } catch (error) {
    if (!isDomainError(error)) throw error;
    if (!(STALE_CODES as readonly string[]).includes(error.code)) {
      logError("confirmation.authorize_rejected", error, { linkId: logId(link.linkId), code: error.code });
    }
    // Nothing was recorded; never a 500 for a rule the client could trip.
    return { status: "stale" };
  }
  if (outcome.changed) return { status: "text_changed" };

  const requester = outcome.names.requester;
  if (input.decision === "declined" && requester?.active) {
    await sendQuietly(
      input.emailProvider,
      declineNotificationEmail({
        to: requester.email,
        requesterName: requester.name,
        contactName: outcome.names.contactName,
        engagementName: outcome.names.engagementName,
        url: confirmationsUrl(input.appUrl, link.engagementId),
      }),
      "confirmation.decline_notice_failed",
      link,
    );
  }
  return { status: "recorded", decision: input.decision };
}

// ---------------------------------------------------------------------------------------------
// Submission

/** One item as submitted from the client form. `version`/`contentHash` bind it to what was shown. */
export interface ClientFormResponse {
  itemId: string;
  version: number;
  contentHash: string;
  decision: "confirm" | "dispute" | "skip";
  comment: string;
}

export type ClientFieldError = "comment_required" | "comment_too_long" | "comment_invalid";

export interface ClientReceiptItem {
  itemId: string;
  shortId: string;
  kind: Kind;
  statement: string;
  decision: ResponseDecision;
  version: number;
  contentHash: string;
}

/** What a submission recorded (D-020): shown on the receipt page and emailed to the contact. */
export interface ClientReceipt {
  submissionId: string;
  engagementName: string;
  clientName: string;
  vendorName: string;
  contactName: string;
  timeZone: string;
  recordedAt: Date;
  items: ClientReceiptItem[];
  /** Log head after the submission. */
  head: { seq: number; hash: string };
}

export type ClientSubmitResult =
  | { status: "recorded"; duplicate: boolean; receipt: ClientReceipt; receiptEmailSent: boolean }
  /** Field errors by item id (e.g. a dispute without a comment). Nothing was recorded. */
  | { status: "invalid"; errors: Record<string, ClientFieldError> }
  /** Every item was skipped or left at the contact's existing response. */
  | { status: "nothing_to_record" }
  /** Latest authorization is missing, declined, or for an older text version. */
  | { status: "authorization_required" }
  /** An item changed since the form was rendered (or the form was tampered with). */
  | { status: "stale" };

/** Server-side validation of the form: a dispute needs a comment of at most COMMENT_MAX characters. */
export function validateClientResponses(responses: readonly ClientFormResponse[]): Record<string, ClientFieldError> {
  const errors: Record<string, ClientFieldError> = {};
  for (const r of responses) {
    if (r.decision !== "dispute") continue;
    const comment = r.comment.trim();
    if (comment === "") errors[r.itemId] = "comment_required";
    else if (comment.length > COMMENT_MAX) errors[r.itemId] = "comment_too_long";
    else if (comment.includes("\u0000")) errors[r.itemId] = "comment_invalid";
  }
  return errors;
}

export interface ClientSubmitInput extends ClientLinkHandle {
  /** Rendered into the form; resubmitting it is a no-op that shows the same receipt. */
  submissionId: string;
  responses: readonly ClientFormResponse[];
  evidence: ClientEvidence;
  emailProvider: EmailProvider;
  appUrl: string;
}

function receiptFrom(state: EngagementState, submissionId: string, names: LinkNames, head: { seq: number; hash: string }): ClientReceipt {
  const items: ClientReceiptItem[] = [];
  let recordedAt: Date | null = null;
  for (const item of state.items.values()) {
    for (const r of item.responses) {
      if (r.submissionId !== submissionId) continue;
      const version = item.versions.find((v) => v.version === r.version);
      items.push({
        itemId: item.id,
        shortId: item.shortId,
        kind: item.kind,
        statement: version?.statement ?? "",
        decision: r.response,
        version: r.version,
        contentHash: r.contentHash,
      });
      recordedAt ??= r.recordedAt;
    }
  }
  items.sort(compareItemRows);
  return {
    submissionId,
    engagementName: names.engagementName,
    clientName: names.clientName,
    vendorName: names.vendorName,
    contactName: names.contactName,
    timeZone: names.timeZone,
    recordedAt: recordedAt ?? new Date(0),
    items,
    head,
  };
}

/**
 * Rule violations a client can hit through races (an item revised, the request revoked or expired,
 * the contact erased while the form was open) or a tampered form, in `clientSubmit` and
 * `clientAuthorize`. Nothing was recorded; the page is shown again (and a link that is no longer
 * valid then gets the 410 page).
 */
const STALE_CODES = [
  "version_mismatch",
  "item_not_active",
  "item_not_found",
  "item_not_in_request",
  "duplicate_item_response",
  "submission_mismatch",
  "request_not_found",
  "request_revoked",
  "request_expired",
  "contact_not_in_request",
  "contact_not_found",
  "contact_erased",
  "empty_submission",
] as const;

/** Comment rules `validateClientResponses` checks first; mapped again in case the command disagrees. */
const FIELD_CODES: Partial<Record<string, ClientFieldError>> = { comment_required: "comment_required", invalid_comment: "comment_invalid" };

/**
 * Records one client submission as a single batch (§8.3 step 5): validates comments, requires a
 * grant of the current authorization text version, drops skipped and unchanged responses, then
 * `recordClientResponses` + dispute notifications in one transaction. Afterwards: a receipt email
 * to the contact and one dispute email to the requester.
 */
export async function clientSubmit(input: ClientSubmitInput): Promise<ClientSubmitResult> {
  const { db, link, clock } = input;
  if (!UUID_PATTERN.test(input.submissionId)) return { status: "stale" };
  const errors = validateClientResponses(input.responses);
  if (Object.keys(errors).length > 0) return { status: "invalid", errors };

  type Outcome =
    | { kind: "result"; result: ClientSubmitResult }
    | { kind: "recorded"; receipt: ClientReceipt; duplicate: boolean; disputedShortIds: string[]; names: LinkNames };

  let outcome: Outcome;
  try {
    outcome = await withTenant(db, { orgId: link.orgId }, async (tx): Promise<Outcome> => {
      await lockEngagement(tx, link.engagementId);
      const names = await loadLinkNames(tx, link);
      const [auth] = await tx
        .select({ decision: contactAuthorization.decision, textVersion: contactAuthorization.textVersion })
        .from(contactAuthorization)
        .where(eq(contactAuthorization.contactId, link.contactId));
      const authorized = auth?.decision === "granted" && auth.textVersion === AUTHORIZATION_TEXT_VERSION;

      const state = await loadState(tx, link.engagementId);
      if (state.submissions.has(input.submissionId)) {
        // Only the contact and request that recorded it may see its receipt again.
        const owner = submissionOwner(state, input.submissionId);
        if (owner?.contactId !== link.contactId || owner.requestId !== link.requestId) return { kind: "result", result: { status: "stale" } };
        return { kind: "recorded", receipt: receiptFrom(state, input.submissionId, names, { seq: state.headSeq, hash: state.headHash }), duplicate: true, disputedShortIds: [], names };
      }
      if (!authorized) return { kind: "result", result: { status: "authorization_required" } };

      // Drop skips and responses equal to the contact's existing response (same decision and comment).
      const commentsBySeq = await existingComments(tx, link, state);
      const changed = input.responses.filter((r) => {
        if (r.decision === "skip") return false;
        const item = state.items.get(r.itemId);
        if (!item) return true;
        let latest: { response: ResponseDecision; seq: number } | null = null;
        for (const resp of item.responses) {
          if (resp.contactId === link.contactId && resp.version === r.version && resp.contentHash === r.contentHash) latest = resp;
        }
        if (!latest) return true;
        const decision: ResponseDecision = r.decision === "confirm" ? "confirmed" : "disputed";
        if (latest.response !== decision) return true;
        return decision === "disputed" && (commentsBySeq.get(latest.seq) ?? null) !== r.comment.trim();
      });
      if (changed.length === 0) return { kind: "result", result: { status: "nothing_to_record" } };

      const result = await recordClientResponses(
        { tx, orgId: link.orgId, clock },
        {
          channel: "email_link",
          engagementId: link.engagementId,
          requestId: link.requestId,
          contactId: link.contactId,
          submissionId: input.submissionId,
          responses: changed.map((r) => ({
            itemId: r.itemId,
            version: r.version,
            contentHash: r.contentHash,
            decision: r.decision === "confirm" ? ("confirmed" as const) : ("disputed" as const),
            comment: r.decision === "dispute" ? r.comment : null,
          })),
          evidence: input.evidence,
        },
      );
      const receipt = receiptFrom(result.state, input.submissionId, names, result.head);
      const disputed = result.events.filter((e) => e.type === "item_disputed");
      const disputedShortIds = receipt.items.filter((i) => i.decision === "disputed").map((i) => i.shortId);
      if (!result.duplicate && disputed.length > 0 && names.requester) {
        await insertNotifications(
          tx,
          disputed.map((e) => ({
            orgId: link.orgId,
            userId: names.requester!.userId,
            engagementId: link.engagementId,
            kind: "item_disputed" as const,
            itemId: (e.payload as { item_id: string }).item_id,
            contactId: link.contactId,
            createdAt: e.recordedAt,
          })),
        );
      }
      return { kind: "recorded", receipt, duplicate: result.duplicate, disputedShortIds: result.duplicate ? [] : disputedShortIds, names };
    });
  } catch (error) {
    if (!isDomainError(error)) throw error;
    if (error.code === "not_authorized") return { status: "authorization_required" };
    const field = FIELD_CODES[error.code];
    const itemId = error.details.itemId;
    if (field && typeof itemId === "string") return { status: "invalid", errors: { [itemId]: field } };
    if (!(STALE_CODES as readonly string[]).includes(error.code)) {
      logError("confirmation.submit_rejected", error, { linkId: logId(link.linkId), code: error.code });
    }
    // Nothing was recorded; never a 500 for a rule the client could trip.
    return { status: "stale" };
  }

  if (outcome.kind === "result") return outcome.result;
  const { receipt, duplicate, names } = outcome;
  let receiptEmailSent = false;
  if (!duplicate) {
    receiptEmailSent = await sendQuietly(input.emailProvider, receiptEmail(receipt, names.contactEmail), "confirmation.receipt_failed", link);
    if (outcome.disputedShortIds.length > 0 && names.requester?.active) {
      await sendQuietly(
        input.emailProvider,
        disputeNotificationEmail({
          to: names.requester.email,
          requesterName: names.requester.name,
          contactName: names.contactName,
          engagementName: names.engagementName,
          shortIds: outcome.disputedShortIds,
          url: confirmationsUrl(input.appUrl, link.engagementId),
        }),
        "confirmation.dispute_notice_failed",
        link,
      );
    }
  }
  return { status: "recorded", duplicate, receipt, receiptEmailSent };
}

/** Comments of this contact's existing disputes, by event seq. */
async function existingComments(tx: Tx, link: ClientLinkContext, state: EngagementState): Promise<Map<number, string>> {
  const seqs: number[] = [];
  for (const item of state.items.values()) {
    for (const r of item.responses) if (r.contactId === link.contactId && r.response === "disputed") seqs.push(r.seq);
  }
  if (seqs.length === 0) return new Map();
  const rows = await tx
    .select({ seq: event.seq, comment: responseComment.comment })
    .from(event)
    .innerJoin(responseComment, eq(responseComment.eventId, event.id))
    .where(and(eq(event.engagementId, link.engagementId), inArray(event.seq, seqs)));
  return new Map(rows.map((r) => [r.seq, r.comment]));
}
