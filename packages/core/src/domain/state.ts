/**
 * Engagement state: the in-memory projection produced by `reduce` (ARCHITECTURE §5.1).
 * All collections are read-only views; the reducer returns new objects instead of mutating.
 */
import { GENESIS_PREV_HASH } from "./chain";
import {
  KIND_LETTER,
  KINDS,
  type Attestation,
  type ConfirmationChannelName,
  type Kind,
  type Manual,
  type Provenance,
  type ReviseReason,
  type SourceFormat,
  type SourceRedactionReason,
  type SourceType,
  type Span,
} from "./events";

export type ItemStatus = "pending" | "confirmed" | "disputed";
export type ItemLifecycle = "active" | "superseded" | "withdrawn";
export type ResponseDecision = "confirmed" | "disputed";
export type AuthorizationDecision = "granted" | "declined";
/** Why a dependent needs review: what happened to its upstream item. */
export type ReviewCause = "revised" | "superseded" | "withdrawn" | "disputed";

export interface EngagementInfo {
  id: string;
  orgId: string;
  shortCode: string;
  name: string;
  clientName: string;
  timeZone: string;
}

export interface SourceState {
  id: string;
  sourceType: SourceType;
  format: SourceFormat;
  occurredAt: Date;
  recordedAt: Date;
  contentSha256: string;
  charLength: number;
  participantCount: number;
  attestation: Attestation;
  /** Actor id of the `source_ingested` event (always a user; falls back to the attester). */
  ingestedBy: string;
  seq: number;
  redacted: { at: Date; reasonCode: SourceRedactionReason; seq: number } | null;
}

export interface ItemVersion {
  version: number;
  contentHash: string;
  /** `previous_content_hash` of the revision; null for version 1. */
  previousContentHash: string | null;
  statement: string;
  spans: readonly Span[];
  manual: Manual | null;
  provenance: Provenance;
  /** Revision reason; null for version 1. */
  reasonCode: ReviseReason | null;
  occurredAt: Date;
  recordedAt: Date;
  seq: number;
}

export interface ItemResponse {
  seq: number;
  version: number;
  contentHash: string;
  contactId: string;
  requestId: string;
  submissionId: string;
  response: ResponseDecision;
  channel: ConfirmationChannelName;
  evidenceCommitment: string;
  commentCommitment: string | null;
  recordedAt: Date;
}

export interface ReviewReason {
  upstreamItemId: string;
  cause: ReviewCause;
  seq: number;
}

export interface ItemState {
  id: string;
  shortId: string;
  kind: Kind;
  /** Every version in the order recorded (`versions[i].version === i + 1` for valid logs). */
  versions: readonly ItemVersion[];
  currentVersion: number;
  /** Derived from `responses` for the current version (D-009); cached by the reducer. */
  status: ItemStatus;
  lifecycle: ItemLifecycle;
  supersededBy: string | null;
  /** depends_on_item_id → seq of the event that added the edge. */
  dependsOn: ReadonlyMap<string, number>;
  needsReview: boolean;
  reviewReasons: readonly ReviewReason[];
  /** Every response on every version, in seq order. */
  responses: readonly ItemResponse[];
  createdAt: Date;
  updatedAt: Date;
  lastSeq: number;
}

export interface RequestedItemRef {
  itemId: string;
  version: number;
  contentHash: string;
}

export interface RequestState {
  id: string;
  items: readonly RequestedItemRef[];
  contactIds: readonly string[];
  /** contact id → time of the first revocation naming that contact. */
  revokedContacts: ReadonlyMap<string, Date>;
  /** Time of the first revocation for all contacts (`contact_id: null`). */
  revokedAllAt: Date | null;
  expiresAt: Date;
  channel: ConfirmationChannelName;
  requestedBy: string | null;
  recordedAt: Date;
  seq: number;
}

export interface AuthorizationState {
  contactId: string;
  decision: AuthorizationDecision;
  requestId: string;
  textVersion: string;
  textSha256: string;
  at: Date;
  seq: number;
}

export interface EngagementState {
  /** Null until `engagement_created` has been reduced. */
  engagement: EngagementInfo | null;
  headSeq: number;
  headHash: string;
  headRecordedAt: Date | null;
  sources: ReadonlyMap<string, SourceState>;
  items: ReadonlyMap<string, ItemState>;
  requests: ReadonlyMap<string, RequestState>;
  /** Latest authorization decision per contact (D-019). */
  authorizations: ReadonlyMap<string, AuthorizationState>;
  submissions: ReadonlySet<string>;
  erasedContacts: ReadonlySet<string>;
  /** Number of items created per kind; the next short id number is counter + 1. */
  kindCounters: Readonly<Record<Kind, number>>;
}

export function emptyState(): EngagementState {
  return {
    engagement: null,
    headSeq: 0,
    headHash: GENESIS_PREV_HASH,
    headRecordedAt: null,
    sources: new Map(),
    items: new Map(),
    requests: new Map(),
    authorizations: new Map(),
    submissions: new Set(),
    erasedContacts: new Set(),
    kindCounters: Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<Kind, number>,
  };
}

export function findVersion(item: Pick<ItemState, "versions">, version: number): ItemVersion | undefined {
  return item.versions.find((v) => v.version === version);
}

/** The current version record. A valid log always has one; falls back to the last version. */
export function currentVersionOf(item: Pick<ItemState, "versions" | "currentVersion">): ItemVersion {
  const found = findVersion(item, item.currentVersion) ?? item.versions[item.versions.length - 1];
  if (!found) throw new Error("item has no versions");
  return found;
}

/** Latest response per contact for one exact version (version and content hash), in seq order. */
export function latestResponsesByContact(
  responses: readonly ItemResponse[],
  version: number,
  contentHash: string,
): ItemResponse[] {
  const latest = new Map<string, ItemResponse>();
  for (const r of responses) {
    if (r.version !== version || r.contentHash !== contentHash) continue;
    const prev = latest.get(r.contactId);
    if (!prev || r.seq >= prev.seq) latest.set(r.contactId, r);
  }
  return [...latest.values()].sort((a, b) => a.seq - b.seq);
}

/** D-009: latest response per contact; any dispute → disputed; else any confirmation → confirmed. */
export function versionStatus(responses: readonly ItemResponse[], version: number, contentHash: string): ItemStatus {
  const latest = latestResponsesByContact(responses, version, contentHash);
  if (latest.some((r) => r.response === "disputed")) return "disputed";
  if (latest.some((r) => r.response === "confirmed")) return "confirmed";
  return "pending";
}

export function deriveStatus(item: Pick<ItemState, "versions" | "currentVersion" | "responses">): ItemStatus {
  const current = findVersion(item, item.currentVersion);
  if (!current) return "pending";
  return versionStatus(item.responses, current.version, current.contentHash);
}

export interface SpanWithCarried extends Span {
  /** True when this exact span (all four fields) was present on the previous version. */
  carried: boolean;
}

function sameSpan(a: Span, b: Span): boolean {
  return a.source_id === b.source_id && a.source_sha256 === b.source_sha256 && a.start === b.start && a.end === b.end;
}

/** Spans of `version` with the `carried` flag (copied unchanged from version - 1). */
export function spansWithCarried(item: Pick<ItemState, "versions">, version: number): SpanWithCarried[] {
  const v = findVersion(item, version);
  if (!v) return [];
  const prev = findVersion(item, version - 1);
  return v.spans.map((s) => ({
    source_id: s.source_id,
    source_sha256: s.source_sha256,
    start: s.start,
    end: s.end,
    carried: prev !== undefined && prev.spans.some((p) => sameSpan(p, s)),
  }));
}

/** When a contact's access through a request was revoked (earliest of per-contact and all), or null. */
export function contactRevokedAt(request: RequestState, contactId: string): Date | null {
  const own = request.revokedContacts.get(contactId) ?? null;
  const all = request.revokedAllAt;
  if (own && all) return own.getTime() <= all.getTime() ? own : all;
  return own ?? all;
}

/** The short id the next item of `kind` gets: `<SHORT_CODE>-<K><n>`, n = 1 + items of that kind. */
export function nextShortId(state: EngagementState, kind: Kind): string {
  if (!state.engagement) throw new Error("engagement not created");
  return `${state.engagement.shortCode}-${KIND_LETTER[kind]}${state.kindCounters[kind] + 1}`;
}
