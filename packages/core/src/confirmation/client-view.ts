// What the client page shows for one link (ARCHITECTURE §8.3): engagement, vendor, the contact's
// authorization status and every requested item version — still open, or "updated since this
// request". Quotes are shown only when `sha256(source text) == span.source_sha256` (§3).
import { and, eq, inArray } from "drizzle-orm";
import { contactPii, event, org, responseComment, sourceContent, withTenant, type Db, type Tx } from "@veradact/db";
import {
  findVersion,
  sha256Hex,
  versionStatus,
  wordDiff,
  type EngagementState,
  type ItemResponse,
  type Kind,
  type ResponseDecision,
  type SourceType,
  type WordDiffSegment,
} from "../domain";
import { compareItemRows } from "../queries";
import { loadState } from "../store";
import { AUTHORIZATION_TEXT_VERSION, renderAuthorizationText } from "./authorization-text";
import type { ClientLinkContext } from "./link-token";

export type ClientAuthorizationStatus =
  | { status: "granted"; at: Date }
  | { status: "declined"; at: Date }
  /** No decision yet, or the latest grant used an older text version (D-019). */
  | { status: "required"; reason: "none" | "text_version_changed" };

export interface ClientQuote {
  /** `verified`: quote shown; `redacted`: the source was deleted; `unavailable`: text missing or changed. */
  state: "verified" | "redacted" | "unavailable";
  quote: string | null;
  sourceType: SourceType | null;
  sourceDate: Date | null;
}

export interface ClientViewItem {
  itemId: string;
  shortId: string;
  kind: Kind;
  /** The requested version (what the contact is asked about). */
  version: number;
  contentHash: string;
  statement: string;
  /** Still active and current at the requested version: the contact can respond. */
  actionable: boolean;
  /** The version has no source quotes ("entered manually"). */
  manual: boolean;
  quotes: ClientQuote[];
  /** When it was said (source date, or the member's date for manual items). */
  occurredAt: Date;
  /** The latest earlier confirmed version, with a word diff from its statement to this one. */
  previouslyConfirmed: { version: number; statement: string; diff: WordDiffSegment[] } | null;
  /** This contact's latest response to this exact version, if any (they may change it, D-029). */
  existingResponse: { decision: ResponseDecision; comment: string | null; recordedAt: Date } | null;
}

export interface ClientView {
  link: ClientLinkContext;
  engagementName: string;
  clientName: string;
  timeZone: string;
  vendorName: string;
  contactName: string;
  expiresAt: Date;
  authorization: ClientAuthorizationStatus;
  /** The current authorization text and version, rendered for this engagement. */
  authorizationText: string;
  authorizationTextVersion: string;
  authorizationTextSha256: string;
  /** Open items, in ledger order. */
  items: ClientViewItem[];
  /** Revised, withdrawn or superseded since the request: shown, no action possible. */
  updatedItems: ClientViewItem[];
}

interface SourceText {
  text: string;
  sha256: string;
}

function latestResponse(responses: readonly ItemResponse[], contactId: string, version: number, contentHash: string): ItemResponse | null {
  let found: ItemResponse | null = null;
  for (const r of responses) {
    if (r.contactId === contactId && r.version === version && r.contentHash === contentHash && (!found || r.seq >= found.seq)) found = r;
  }
  return found;
}

function authorizationStatus(state: EngagementState, contactId: string): ClientAuthorizationStatus {
  const latest = state.authorizations.get(contactId);
  if (!latest) return { status: "required", reason: "none" };
  if (latest.decision === "declined") return { status: "declined", at: latest.at };
  if (latest.textVersion !== AUTHORIZATION_TEXT_VERSION) return { status: "required", reason: "text_version_changed" };
  return { status: "granted", at: latest.at };
}

/**
 * Builds the client view inside a tenant transaction. `state` may be passed when the caller has
 * already folded the log. Throws if the request or engagement is missing (callers resolve the link
 * first, so that means a bug, not a user error).
 */
export async function buildClientView(tx: Tx, link: ClientLinkContext, state?: EngagementState): Promise<ClientView> {
  const s = state ?? (await loadState(tx, link.engagementId));
  const request = s.requests.get(link.requestId);
  if (!s.engagement || !request) throw new Error("client view: request not found");

  const [vendor] = await tx.select({ name: org.name }).from(org).where(eq(org.id, link.orgId));
  const [contact] = await tx.select({ name: contactPii.name }).from(contactPii).where(eq(contactPii.contactId, link.contactId));

  const requested = request.items
    .map((ref) => ({ ref, item: s.items.get(ref.itemId) }))
    .filter((r): r is { ref: typeof r.ref; item: NonNullable<typeof r.item> } => r.item !== undefined);

  // Source texts for every span of the requested versions (verified against source_sha256 below).
  const sourceIds = [
    ...new Set(requested.flatMap(({ ref, item }) => (findVersion(item, ref.version)?.spans ?? []).map((sp) => sp.source_id))),
  ];
  const texts = new Map<string, SourceText>();
  if (sourceIds.length) {
    const rows = await tx.select({ sourceId: sourceContent.sourceId, text: sourceContent.text }).from(sourceContent).where(inArray(sourceContent.sourceId, sourceIds));
    for (const r of rows) texts.set(r.sourceId, { text: r.text, sha256: sha256Hex(r.text) });
  }

  // Existing responses of this contact, and their dispute comments (erasable side table).
  const existing = new Map<string, ItemResponse>();
  for (const { ref, item } of requested) {
    const r = latestResponse(item.responses, link.contactId, ref.version, ref.contentHash);
    if (r) existing.set(ref.itemId, r);
  }
  const comments = new Map<number, string>();
  const disputedSeqs = [...existing.values()].filter((r) => r.response === "disputed").map((r) => r.seq);
  if (disputedSeqs.length) {
    const rows = await tx
      .select({ seq: event.seq, comment: responseComment.comment })
      .from(event)
      .innerJoin(responseComment, eq(responseComment.eventId, event.id))
      .where(and(eq(event.engagementId, link.engagementId), inArray(event.seq, disputedSeqs)));
    for (const r of rows) comments.set(r.seq, r.comment);
  }

  const views: ClientViewItem[] = requested.flatMap(({ ref, item }) => {
    const version = findVersion(item, ref.version);
    if (!version || version.contentHash !== ref.contentHash) return [];
    const current = findVersion(item, item.currentVersion);
    const actionable = item.lifecycle === "active" && current?.version === ref.version && current.contentHash === ref.contentHash;

    const quotes: ClientQuote[] = version.spans.map((span) => {
      const src = s.sources.get(span.source_id);
      const content = texts.get(span.source_id);
      const verified = content !== undefined && content.sha256 === span.source_sha256 && span.end <= content.text.length;
      return {
        state: verified ? "verified" : src?.redacted ? "redacted" : "unavailable",
        quote: verified ? content.text.slice(span.start, span.end) : null,
        sourceType: src?.sourceType ?? null,
        sourceDate: src?.occurredAt ?? null,
      };
    });

    const earlierConfirmed = [...item.versions]
      .filter((v) => v.version < ref.version)
      .sort((a, b) => b.version - a.version)
      .find((v) => versionStatus(item.responses, v.version, v.contentHash) === "confirmed");

    const own = existing.get(ref.itemId);
    return [
      {
        itemId: item.id,
        shortId: item.shortId,
        kind: item.kind,
        version: version.version,
        contentHash: version.contentHash,
        statement: version.statement,
        actionable,
        manual: version.manual !== null,
        quotes,
        occurredAt: version.occurredAt,
        previouslyConfirmed: earlierConfirmed
          ? { version: earlierConfirmed.version, statement: earlierConfirmed.statement, diff: wordDiff(earlierConfirmed.statement, version.statement) }
          : null,
        existingResponse: own ? { decision: own.response, comment: comments.get(own.seq) ?? null, recordedAt: own.recordedAt } : null,
      },
    ];
  });
  views.sort(compareItemRows);

  const vendorName = vendor?.name ?? "";
  const authorizationText = renderAuthorizationText({
    vendorName,
    engagementName: s.engagement.name,
    clientName: s.engagement.clientName,
  });
  return {
    link,
    engagementName: s.engagement.name,
    clientName: s.engagement.clientName,
    timeZone: s.engagement.timeZone,
    vendorName,
    contactName: contact?.name ?? "",
    expiresAt: request.expiresAt,
    authorization: authorizationStatus(s, link.contactId),
    authorizationText,
    authorizationTextVersion: AUTHORIZATION_TEXT_VERSION,
    authorizationTextSha256: sha256Hex(authorizationText),
    items: views.filter((v) => v.actionable),
    updatedItems: views.filter((v) => !v.actionable),
  };
}

/** The client page's data for a resolved link (one tenant transaction, one fold of the log). */
export async function loadClientView(db: Db, link: ClientLinkContext, _options: { clock: () => Date }): Promise<ClientView> {
  return withTenant(db, { orgId: link.orgId }, (tx) => buildClientView(tx, link));
}
