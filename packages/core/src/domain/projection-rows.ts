/**
 * Projection rows (ARCHITECTURE §2.3) as a pure function of state.
 *
 * Keys are the camelCase column names; timestamps are Dates; jsonb columns hold plain JSON with
 * snake_case keys (like event payloads). Rows are sorted by `PROJECTION_SORT_KEYS` so that
 * `projectRows(fold(events))` can be compared with a database dump ordered the same way.
 * Lowercase UUID strings sort identically in JavaScript and in Postgres (`uuid` ordering).
 */
import type { Attestation, Kind, Manual, Provenance, ReviseReason, SourceFormat, SourceRedactionReason, SourceType } from "./events";
import {
  contactRevokedAt,
  spansWithCarried,
  type AuthorizationDecision,
  type EngagementState,
  type ItemLifecycle,
  type ItemStatus,
  type ResponseDecision,
  type ReviewCause,
  type SpanWithCarried,
} from "./state";

export interface SourceRow {
  id: string;
  orgId: string;
  engagementId: string;
  sourceType: SourceType;
  format: SourceFormat;
  occurredAt: Date;
  recordedAt: Date;
  contentSha256: string;
  charLength: number;
  participantCount: number;
  attestation: Attestation;
  ingestedBy: string;
  redactedAt: Date | null;
  redactionReason: SourceRedactionReason | null;
}

/** jsonb element of `item.review_reasons`. */
export interface ReviewReasonJson {
  upstream_item_id: string;
  cause: ReviewCause;
  seq: number;
}

export interface ItemRow {
  id: string;
  orgId: string;
  engagementId: string;
  shortId: string;
  kind: Kind;
  currentVersion: number;
  status: ItemStatus;
  lifecycle: ItemLifecycle;
  supersededBy: string | null;
  needsReview: boolean;
  reviewReasons: ReviewReasonJson[];
  createdAt: Date;
  updatedAt: Date;
  lastSeq: number;
}

export interface ItemVersionRow {
  itemId: string;
  version: number;
  orgId: string;
  engagementId: string;
  contentHash: string;
  statement: string;
  /** `[{ source_id, source_sha256, start, end, carried }]` */
  spans: SpanWithCarried[];
  manual: Manual | null;
  provenance: Provenance;
  reasonCode: ReviseReason | null;
  occurredAt: Date;
  recordedAt: Date;
  eventSeq: number;
}

export interface ItemDependencyRow {
  orgId: string;
  engagementId: string;
  itemId: string;
  dependsOnItemId: string;
  addedSeq: number;
}

export interface ItemResponseRow {
  orgId: string;
  engagementId: string;
  eventSeq: number;
  itemId: string;
  version: number;
  contentHash: string;
  contactId: string;
  requestId: string;
  submissionId: string;
  response: ResponseDecision;
  commentCommitment: string | null;
  recordedAt: Date;
}

export interface ConfirmationRequestRow {
  id: string;
  orgId: string;
  engagementId: string;
  requestedBy: string | null;
  expiresAt: Date;
  recordedAt: Date;
  eventSeq: number;
}

export interface ConfirmationRequestItemRow {
  orgId: string;
  engagementId: string;
  requestId: string;
  itemId: string;
  version: number;
  contentHash: string;
}

export interface ConfirmationRequestContactRow {
  orgId: string;
  engagementId: string;
  requestId: string;
  contactId: string;
  revokedAt: Date | null;
}

export interface ContactAuthorizationRow {
  orgId: string;
  engagementId: string;
  contactId: string;
  requestId: string;
  decision: AuthorizationDecision;
  textVersion: string;
  textSha256: string;
  recordedAt: Date;
  eventSeq: number;
}

/** One array per projection table, keyed by table name. */
export interface ProjectionRows {
  source: SourceRow[];
  item: ItemRow[];
  item_version: ItemVersionRow[];
  item_dependency: ItemDependencyRow[];
  item_response: ItemResponseRow[];
  confirmation_request: ConfirmationRequestRow[];
  confirmation_request_item: ConfirmationRequestItemRow[];
  confirmation_request_contact: ConfirmationRequestContactRow[];
  contact_authorization: ContactAuthorizationRow[];
}

export type ProjectionTable = keyof ProjectionRows;

export const PROJECTION_TABLES: readonly ProjectionTable[] = [
  "source",
  "item",
  "item_version",
  "item_dependency",
  "item_response",
  "confirmation_request",
  "confirmation_request_item",
  "confirmation_request_contact",
  "contact_authorization",
];

/** Row order per table (ascending, compared left to right). Each list is a unique key. */
export const PROJECTION_SORT_KEYS: { readonly [T in ProjectionTable]: readonly (keyof ProjectionRows[T][number])[] } = {
  source: ["id"],
  item: ["id"],
  item_version: ["itemId", "version"],
  item_dependency: ["itemId", "dependsOnItemId"],
  item_response: ["eventSeq"],
  confirmation_request: ["id"],
  confirmation_request_item: ["requestId", "itemId"],
  confirmation_request_contact: ["requestId", "contactId"],
  contact_authorization: ["contactId"],
};

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function sortRows(table: ProjectionTable, rows: readonly object[]): void {
  const keys = PROJECTION_SORT_KEYS[table] as readonly string[];
  (rows as Record<string, unknown>[]).sort((a, b) => {
    for (const k of keys) {
      const c = compareValues(a[k], b[k]);
      if (c !== 0) return c;
    }
    return 0;
  });
}

const copyDate = (d: Date) => new Date(d.getTime());
const copyDateOrNull = (d: Date | null) => (d ? new Date(d.getTime()) : null);

export function emptyProjectionRows(): ProjectionRows {
  return {
    source: [],
    item: [],
    item_version: [],
    item_dependency: [],
    item_response: [],
    confirmation_request: [],
    confirmation_request_item: [],
    confirmation_request_contact: [],
    contact_authorization: [],
  };
}

/**
 * Every projection row for the engagement in `state`. Returns empty arrays before
 * `engagement_created`. The result shares no objects with `state`.
 */
export function projectRows(state: EngagementState): ProjectionRows {
  const rows = emptyProjectionRows();
  if (!state.engagement) return rows;
  const orgId = state.engagement.orgId;
  const engagementId = state.engagement.id;

  for (const s of state.sources.values()) {
    rows.source.push({
      id: s.id,
      orgId,
      engagementId,
      sourceType: s.sourceType,
      format: s.format,
      occurredAt: copyDate(s.occurredAt),
      recordedAt: copyDate(s.recordedAt),
      contentSha256: s.contentSha256,
      charLength: s.charLength,
      participantCount: s.participantCount,
      attestation: structuredClone(s.attestation),
      ingestedBy: s.ingestedBy,
      redactedAt: copyDateOrNull(s.redacted?.at ?? null),
      redactionReason: s.redacted?.reasonCode ?? null,
    });
  }

  for (const item of state.items.values()) {
    rows.item.push({
      id: item.id,
      orgId,
      engagementId,
      shortId: item.shortId,
      kind: item.kind,
      currentVersion: item.currentVersion,
      status: item.status,
      lifecycle: item.lifecycle,
      supersededBy: item.supersededBy,
      needsReview: item.needsReview,
      reviewReasons: item.reviewReasons.map((r) => ({ upstream_item_id: r.upstreamItemId, cause: r.cause, seq: r.seq })),
      createdAt: copyDate(item.createdAt),
      updatedAt: copyDate(item.updatedAt),
      lastSeq: item.lastSeq,
    });
    for (const v of item.versions) {
      rows.item_version.push({
        itemId: item.id,
        version: v.version,
        orgId,
        engagementId,
        contentHash: v.contentHash,
        statement: v.statement,
        spans: spansWithCarried(item, v.version),
        manual: v.manual ? { entered_by: v.manual.entered_by } : null,
        provenance: structuredClone(v.provenance),
        reasonCode: v.reasonCode,
        occurredAt: copyDate(v.occurredAt),
        recordedAt: copyDate(v.recordedAt),
        eventSeq: v.seq,
      });
    }
    for (const [dependsOnItemId, addedSeq] of item.dependsOn) {
      rows.item_dependency.push({ orgId, engagementId, itemId: item.id, dependsOnItemId, addedSeq });
    }
    for (const r of item.responses) {
      rows.item_response.push({
        orgId,
        engagementId,
        eventSeq: r.seq,
        itemId: item.id,
        version: r.version,
        contentHash: r.contentHash,
        contactId: r.contactId,
        requestId: r.requestId,
        submissionId: r.submissionId,
        response: r.response,
        commentCommitment: r.commentCommitment,
        recordedAt: copyDate(r.recordedAt),
      });
    }
  }

  for (const req of state.requests.values()) {
    rows.confirmation_request.push({
      id: req.id,
      orgId,
      engagementId,
      requestedBy: req.requestedBy,
      expiresAt: copyDate(req.expiresAt),
      recordedAt: copyDate(req.recordedAt),
      eventSeq: req.seq,
    });
    const seenItems = new Set<string>();
    for (const i of req.items) {
      if (seenItems.has(i.itemId)) continue;
      seenItems.add(i.itemId);
      rows.confirmation_request_item.push({
        orgId,
        engagementId,
        requestId: req.id,
        itemId: i.itemId,
        version: i.version,
        contentHash: i.contentHash,
      });
    }
    for (const contactId of new Set(req.contactIds)) {
      rows.confirmation_request_contact.push({
        orgId,
        engagementId,
        requestId: req.id,
        contactId,
        revokedAt: copyDateOrNull(contactRevokedAt(req, contactId)),
      });
    }
  }

  for (const a of state.authorizations.values()) {
    rows.contact_authorization.push({
      orgId,
      engagementId,
      contactId: a.contactId,
      requestId: a.requestId,
      decision: a.decision,
      textVersion: a.textVersion,
      textSha256: a.textSha256,
      recordedAt: copyDate(a.at),
      eventSeq: a.seq,
    });
  }

  for (const table of PROJECTION_TABLES) sortRows(table, rows[table]);
  return rows;
}

