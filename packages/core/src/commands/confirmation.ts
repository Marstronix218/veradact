// Client confirmation, domain level (ARCHITECTURE §8.1, §8.4; D-009, D-019, D-029). Email
// delivery, link tokens and the client page are built on top of these commands.
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { confirmationEvidence, confirmationLink, responseComment, type Tx } from "@veradact/db";
import { writeAudit } from "../audit";
import {
  canonicalJson,
  contactRevokedAt,
  currentVersionOf,
  hmacSha256Hex,
  nextRecordedAt,
  sha256Hex,
  type ConfirmationChannelName,
  type EngagementState,
  type EventDraft,
  type RequestState,
  type StoredEvent,
} from "../domain";
import { DomainError } from "../errors";
import { appendEvents } from "../store";
import { requireLiveContact, type LiveContact } from "./contacts";
import {
  fixedClock,
  lockAndLoad,
  runInTenant,
  userActor,
  userOrSystemActor,
  type ClientCommandContext,
  type CommandContext,
  type UserOrSystemContext,
} from "./context";
import { requireActiveItem } from "./items";

export const DEFAULT_CONFIRMATION_EXPIRY_DAYS = 14;
const DAY_MS = 86_400_000;
export const COMMENT_MAX = 5000;
const AUTHORIZATION_TEXT_MAX = 4000;

/** Network evidence captured with a client action; snapshotted with name/email (§6). */
export interface ClientEvidence {
  ip: string | null;
  userAgent: string | null;
}

/** `HMAC(contact key, canonical{ name, email, ip, user_agent })` (ARCHITECTURE §6). */
export function evidenceCommitment(contact: Pick<LiveContact, "hmacKey" | "name" | "email">, evidence: ClientEvidence): string {
  return hmacSha256Hex(
    contact.hmacKey,
    canonicalJson({ name: contact.name, email: contact.email, ip: evidence.ip, user_agent: evidence.userAgent }),
  );
}

/** `HMAC(contact key, comment)` (ARCHITECTURE §6). */
export function commentCommitment(contact: Pick<LiveContact, "hmacKey">, comment: string): string {
  return hmacSha256Hex(contact.hmacKey, comment);
}

function requireRequest(state: EngagementState, requestId: string): RequestState {
  const request = state.requests.get(requestId);
  if (!request) throw new DomainError("request_not_found", { requestId });
  return request;
}

/** Request includes the contact, is not revoked for them, and has not expired at `at`. */
function requireOpenForContact(request: RequestState, contactId: string, at: Date): void {
  if (!request.contactIds.includes(contactId)) throw new DomainError("contact_not_in_request", { requestId: request.id, contactId });
  if (contactRevokedAt(request, contactId) !== null) throw new DomainError("request_revoked", { requestId: request.id });
  if (at.getTime() >= request.expiresAt.getTime()) throw new DomainError("request_expired", { requestId: request.id });
}

async function writeEvidence(tx: Tx, orgId: string, eventId: number, contact: LiveContact, evidence: ClientEvidence): Promise<void> {
  await tx.insert(confirmationEvidence).values({
    eventId,
    orgId,
    contactId: contact.contactId,
    name: contact.name,
    email: contact.email,
    ip: evidence.ip,
    userAgent: evidence.userAgent,
  });
}

// ---------------------------------------------------------------------------------------------
// Request / revoke (member actions)

export interface RequestConfirmationInput {
  engagementId: string;
  /** Defaults to a random UUID. */
  requestId?: string;
  /**
   * Items to confirm, each at its current version. `version`/`contentHash`, when given, must still
   * be current (the member saw that version) or the command fails with `version_mismatch`.
   */
  items: readonly { itemId: string; version?: number; contentHash?: string }[];
  contactIds: readonly string[];
  /** Defaults to 14 days after now. */
  expiresAt?: Date;
}

export interface ConfirmationLinkRef {
  linkId: string;
  contactId: string;
  expiresAt: Date;
}

export interface RequestConfirmationResult {
  requestId: string;
  links: ConfirmationLinkRef[];
  events: StoredEvent[];
  state: EngagementState;
}

/**
 * Appends `confirmation_requested` for active pending/disputed items at their current version and
 * creates one `confirmation_link` per contact (`sent_to_email` copied from `contact_pii`). Sends
 * nothing; delivery is the channel's job.
 */
export async function requestConfirmation(ctx: CommandContext, input: RequestConfirmationInput): Promise<RequestConfirmationResult> {
  const requestId = input.requestId ?? randomUUID();
  return runInTenant(ctx, async (tx) => {
    const { state } = await lockAndLoad(tx, input.engagementId);
    if (state.requests.has(requestId)) throw new DomainError("invalid_event", { type: "confirmation_requested", issues: ["request id already used"] });

    const itemIds = [...new Set(input.items.map((i) => i.itemId))];
    const contactIds = [...new Set(input.contactIds)];
    if (itemIds.length === 0 || contactIds.length === 0) {
      throw new DomainError("invalid_event", { type: "confirmation_requested", issues: ["at least one item and one contact are required"] });
    }
    const items = itemIds.map((itemId) => {
      const item = requireActiveItem(state, itemId);
      if (item.status === "confirmed") throw new DomainError("item_not_requestable", { itemId });
      const current = currentVersionOf(item);
      for (const given of input.items.filter((i) => i.itemId === itemId)) {
        if ((given.version !== undefined && given.version !== current.version) || (given.contentHash !== undefined && given.contentHash !== current.contentHash)) {
          throw new DomainError("version_mismatch", { itemId, currentVersion: current.version });
        }
      }
      return { item_id: itemId, version: current.version, content_hash: current.contentHash };
    });
    const contacts: LiveContact[] = [];
    for (const contactId of contactIds) {
      if (state.erasedContacts.has(contactId)) throw new DomainError("contact_erased", { contactId });
      contacts.push(await requireLiveContact(tx, input.engagementId, contactId));
    }

    const now = ctx.clock();
    const recordedAt = nextRecordedAt(now, state.headRecordedAt);
    const expiresAt = new Date(Math.trunc((input.expiresAt ?? new Date(recordedAt.getTime() + DEFAULT_CONFIRMATION_EXPIRY_DAYS * DAY_MS)).getTime()));
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= recordedAt.getTime()) throw new DomainError("invalid_expiry");

    const appended = await appendEvents(
      tx,
      input.engagementId,
      [
        {
          type: "confirmation_requested",
          actor: userActor(ctx.userId),
          payload: { request_id: requestId, items, contact_ids: contactIds, expires_at: expiresAt.toISOString(), channel: "email_link" },
        },
      ],
      { clock: fixedClock(now), state },
    );
    const createdAt = appended.events[0]!.recordedAt;
    const links = contacts.map((c) => ({ linkId: randomUUID(), contactId: c.contactId, expiresAt }));
    await tx.insert(confirmationLink).values(
      links.map((link, i) => ({
        id: link.linkId,
        orgId: ctx.orgId,
        engagementId: input.engagementId,
        requestId,
        contactId: link.contactId,
        sentToEmail: contacts[i]!.email,
        expiresAt,
        createdAt,
      })),
    );
    await writeAudit(tx, {
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      action: "confirmation.request",
      targetType: "confirmation_request",
      targetId: requestId,
      metadata: { item_count: items.length, contact_count: contacts.length },
      at: now,
    });
    return { requestId, links, events: appended.events, state: appended.state };
  });
}

export interface RevokeConfirmationInput {
  engagementId: string;
  requestId: string;
  /** One contact, or null/omitted for every contact on the request. */
  contactId?: string | null;
}

/** Appends `confirmation_revoked` and revokes the matching links. `userId: null` = system. */
export async function revokeConfirmation(
  ctx: UserOrSystemContext,
  input: RevokeConfirmationInput,
): Promise<{ events: StoredEvent[]; state: EngagementState }> {
  const contactId = input.contactId ?? null;
  return runInTenant(ctx, async (tx) => {
    const { state } = await lockAndLoad(tx, input.engagementId);
    const request = requireRequest(state, input.requestId);
    if (request.revokedAllAt !== null) throw new DomainError("request_revoked", { requestId: request.id });
    if (contactId !== null) {
      if (!request.contactIds.includes(contactId)) throw new DomainError("contact_not_in_request", { requestId: request.id, contactId });
      if (request.revokedContacts.has(contactId)) throw new DomainError("request_revoked", { requestId: request.id });
    }
    const now = ctx.clock();
    const appended = await appendEvents(
      tx,
      input.engagementId,
      [{ type: "confirmation_revoked", actor: userOrSystemActor(ctx.userId), payload: { request_id: request.id, contact_id: contactId } }],
      { clock: fixedClock(now), state },
    );
    const revokedAt = appended.events[0]!.recordedAt;
    await tx
      .update(confirmationLink)
      .set({ revokedAt })
      .where(
        and(
          eq(confirmationLink.requestId, request.id),
          isNull(confirmationLink.revokedAt),
          ...(contactId !== null ? [eq(confirmationLink.contactId, contactId)] : []),
        ),
      );
    await writeAudit(tx, {
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      action: "confirmation.revoke",
      targetType: "confirmation_request",
      targetId: request.id,
      metadata: { all_contacts: contactId === null },
      at: now,
    });
    return { events: appended.events, state: appended.state };
  });
}

// ---------------------------------------------------------------------------------------------
// Client actions (the actor is the contact)

export interface RecordAuthorizationInput {
  engagementId: string;
  requestId: string;
  contactId: string;
  decision: "granted" | "declined";
  /** The exact rendered authorization text the contact saw. */
  text: string;
  textVersion: string;
  evidence: ClientEvidence;
}

export interface ClientActionResult {
  events: StoredEvent[];
  eventIds: number[];
  state: EngagementState;
}

/**
 * Appends `authorization_granted` / `authorization_declined` (latest per contact wins, D-019) with
 * an evidence commitment keyed by the contact's HMAC key, and snapshots the evidence.
 */
export async function recordAuthorization(ctx: ClientCommandContext, input: RecordAuthorizationInput): Promise<ClientActionResult> {
  if (input.text.trim() === "" || input.text.length > AUTHORIZATION_TEXT_MAX) throw new DomainError("invalid_authorization_text");
  return runInTenant(ctx, async (tx) => {
    const { state } = await lockAndLoad(tx, input.engagementId);
    if (state.erasedContacts.has(input.contactId)) throw new DomainError("contact_erased", { contactId: input.contactId });
    const contact = await requireLiveContact(tx, input.engagementId, input.contactId);
    const request = requireRequest(state, input.requestId);
    const now = ctx.clock();
    requireOpenForContact(request, contact.contactId, nextRecordedAt(now, state.headRecordedAt));

    const payload = {
      contact_id: contact.contactId,
      request_id: request.id,
      text_version: input.textVersion,
      text: input.text,
      text_sha256: sha256Hex(input.text),
      evidence_commitment: evidenceCommitment(contact, input.evidence),
    };
    const actor = { type: "contact" as const, id: contact.contactId };
    const draft: EventDraft =
      input.decision === "granted" ? { type: "authorization_granted", actor, payload } : { type: "authorization_declined", actor, payload };
    const appended = await appendEvents(tx, input.engagementId, [draft], { clock: fixedClock(now), state });
    await writeEvidence(tx, ctx.orgId, appended.eventIds[0]!, contact, input.evidence);
    return { events: appended.events, eventIds: appended.eventIds, state: appended.state };
  });
}

export interface ClientResponseInput {
  itemId: string;
  version: number;
  contentHash: string;
  decision: "confirmed" | "disputed";
  /** Required for disputes (kept in `response_comment`); ignored for confirmations. */
  comment?: string | null;
}

export interface RecordClientResponsesInput {
  channel: ConfirmationChannelName;
  engagementId: string;
  requestId: string;
  contactId: string;
  /** Rendered into the form; resubmitting the same submission is a no-op. */
  submissionId: string;
  responses: readonly ClientResponseInput[];
  evidence: ClientEvidence;
}

export interface RecordClientResponsesResult extends ClientActionResult {
  /** True when this submission id was already recorded (nothing was written). */
  duplicate: boolean;
  /** Log head after the submission, for the receipt (D-020). */
  head: { seq: number; hash: string };
}

/**
 * Records one client submission (ARCHITECTURE §8.4) as a single append batch: validates the
 * authorization, request membership of the exact item version + content hash, revocation, expiry,
 * that each item is still active at that version (stale versions → `version_mismatch`), then
 * writes `item_confirmed` / `item_disputed`, the evidence snapshots and dispute comments.
 */
export async function recordClientResponses(
  ctx: ClientCommandContext,
  input: RecordClientResponsesInput,
): Promise<RecordClientResponsesResult> {
  if (input.responses.length === 0) throw new DomainError("empty_submission");
  const seen = new Set<string>();
  const comments = input.responses.map((r) => {
    if (seen.has(r.itemId)) throw new DomainError("duplicate_item_response", { itemId: r.itemId });
    seen.add(r.itemId);
    if (r.decision !== "disputed") return null;
    const comment = (r.comment ?? "").trim();
    if (comment === "") throw new DomainError("comment_required", { itemId: r.itemId });
    if (comment.length > COMMENT_MAX || comment.includes("\u0000")) throw new DomainError("invalid_comment", { itemId: r.itemId });
    return comment;
  });

  return runInTenant(ctx, async (tx) => {
    const { state } = await lockAndLoad(tx, input.engagementId);
    if (state.submissions.has(input.submissionId)) {
      return { duplicate: true, events: [], eventIds: [], state, head: { seq: state.headSeq, hash: state.headHash } };
    }
    const authorization = state.authorizations.get(input.contactId);
    if (state.erasedContacts.has(input.contactId)) throw new DomainError("contact_erased", { contactId: input.contactId });
    if (authorization?.decision !== "granted") throw new DomainError("not_authorized", { contactId: input.contactId });
    const contact = await requireLiveContact(tx, input.engagementId, input.contactId);
    const request = requireRequest(state, input.requestId);
    const now = ctx.clock();
    requireOpenForContact(request, contact.contactId, nextRecordedAt(now, state.headRecordedAt));

    const evidence = evidenceCommitment(contact, input.evidence);
    const actor = { type: "contact" as const, id: contact.contactId };
    const drafts: EventDraft[] = input.responses.map((r, i) => {
      if (!request.items.some((ri) => ri.itemId === r.itemId && ri.version === r.version && ri.contentHash === r.contentHash)) {
        throw new DomainError("item_not_in_request", { itemId: r.itemId, requestId: request.id });
      }
      const item = requireActiveItem(state, r.itemId);
      const current = currentVersionOf(item);
      if (current.version !== r.version || current.contentHash !== r.contentHash) {
        throw new DomainError("version_mismatch", { itemId: r.itemId, currentVersion: current.version });
      }
      const base = {
        item_id: r.itemId,
        version: r.version,
        content_hash: r.contentHash,
        contact_id: contact.contactId,
        request_id: request.id,
        submission_id: input.submissionId,
        channel: input.channel,
        evidence_commitment: evidence,
      };
      const comment = comments[i];
      return comment === null || comment === undefined
        ? { type: "item_confirmed", actor, payload: base }
        : { type: "item_disputed", actor, payload: { ...base, comment_commitment: commentCommitment(contact, comment) } };
    });

    const appended = await appendEvents(tx, input.engagementId, drafts, { clock: fixedClock(now), state });
    for (const [i, eventId] of appended.eventIds.entries()) {
      await writeEvidence(tx, ctx.orgId, eventId, contact, input.evidence);
      const comment = comments[i];
      if (comment !== null && comment !== undefined) {
        await tx.insert(responseComment).values({ eventId, orgId: ctx.orgId, contactId: contact.contactId, comment });
      }
    }
    return {
      duplicate: false,
      events: appended.events,
      eventIds: appended.eventIds,
      state: appended.state,
      head: { seq: appended.state.headSeq, hash: appended.state.headHash },
    };
  });
}
