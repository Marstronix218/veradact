// Item read helpers for the vendor UI and exports, over the projection tables (ARCHITECTURE §2.3,
// §13). Quotes are shown only after `sha256(source text) == span.source_sha256` is re-checked.
import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import {
  appUser,
  candidate,
  clientContact,
  contactPii,
  event,
  eventNote,
  item,
  itemDependency,
  itemResponse,
  itemVersion,
  responseComment,
  source,
  sourceContent,
  type Tx,
} from "@veradact/db";
import {
  KINDS,
  sha256Hex,
  UUID_PATTERN,
  type ItemLifecycle,
  type ItemStatus,
  type Kind,
  type Provenance,
  type ResponseDecision,
  type ReviewCause,
  type ReviseReason,
  type SourceType,
} from "../domain";

/** Display name for a contact whose PII has been erased (ARCHITECTURE §6). */
export const ERASED_CONTACT_NAME = "Erased contact";

const KIND_ORDER = new Map<string, number>(KINDS.map((k, i) => [k, i]));
const oneOrMany = <T>(v: T | readonly T[] | undefined): readonly T[] | undefined => (v === undefined ? undefined : Array.isArray(v) ? v : [v as T]);

function shortIdNumber(shortId: string): number {
  const n = Number(/(\d+)$/.exec(shortId)?.[1] ?? "0");
  return Number.isFinite(n) ? n : 0;
}

/** Ledger order: kind (problem → requirement), then short id number. */
export function compareItemRows(a: { kind: string; shortId: string }, b: { kind: string; shortId: string }): number {
  return (KIND_ORDER.get(a.kind) ?? 99) - (KIND_ORDER.get(b.kind) ?? 99) || shortIdNumber(a.shortId) - shortIdNumber(b.shortId);
}

export interface ItemListFilters {
  kind?: Kind | readonly Kind[];
  status?: ItemStatus | readonly ItemStatus[];
  lifecycle?: ItemLifecycle | readonly ItemLifecycle[];
  needsReview?: boolean;
}

export interface ItemListRow {
  id: string;
  shortId: string;
  kind: Kind;
  currentVersion: number;
  status: ItemStatus;
  lifecycle: ItemLifecycle;
  supersededBy: string | null;
  needsReview: boolean;
  statement: string;
  contentHash: string;
  /** The current version was entered manually (no source spans). */
  manual: boolean;
  spanCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Items of the engagement at their current version, filtered, in ledger order. */
export async function listItems(tx: Tx, engagementId: string, filters: ItemListFilters = {}): Promise<ItemListRow[]> {
  const conditions: SQL[] = [eq(item.engagementId, engagementId)];
  const kinds = oneOrMany(filters.kind);
  const statuses = oneOrMany(filters.status);
  const lifecycles = oneOrMany(filters.lifecycle);
  // An empty list means "no filter" (nothing ticked in the UI).
  if (kinds?.length) conditions.push(inArray(item.kind, [...kinds]));
  if (statuses?.length) conditions.push(inArray(item.status, [...statuses]));
  if (lifecycles?.length) conditions.push(inArray(item.lifecycle, [...lifecycles]));
  if (filters.needsReview !== undefined) conditions.push(eq(item.needsReview, filters.needsReview));
  const rows = await tx
    .select({
      id: item.id,
      shortId: item.shortId,
      kind: item.kind,
      currentVersion: item.currentVersion,
      status: item.status,
      lifecycle: item.lifecycle,
      supersededBy: item.supersededBy,
      needsReview: item.needsReview,
      statement: itemVersion.statement,
      contentHash: itemVersion.contentHash,
      manual: itemVersion.manual,
      spans: itemVersion.spans,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    })
    .from(item)
    .innerJoin(itemVersion, and(eq(itemVersion.itemId, item.id), eq(itemVersion.version, item.currentVersion)))
    .where(and(...conditions));
  return rows
    .map(({ spans, manual, ...r }) => ({ ...r, manual: manual !== null, spanCount: (spans as unknown[]).length }))
    .sort(compareItemRows);
}

// ---------------------------------------------------------------------------------------------
// Item detail

export interface ItemRef {
  id: string;
  shortId: string;
  kind: Kind;
  currentVersion: number;
  status: ItemStatus;
  lifecycle: ItemLifecycle;
  statement: string;
}

export type QuoteState = "verified" | "redacted" | "unavailable";

export interface SpanDetail {
  sourceId: string;
  sourceSha256: string;
  start: number;
  end: number;
  /** Copied unchanged from the previous version. */
  carried: boolean;
  /** `text.slice(start, end)`, only when the source text still exists and its hash matches. */
  quote: string | null;
  /** `redacted`: the source was redacted (show "source redacted on <date>"); `unavailable`: text missing or changed. */
  quoteState: QuoteState;
  sourceType: SourceType | null;
  sourceTitle: string | null;
  sourceOccurredAt: Date | null;
  sourceRedactedAt: Date | null;
}

export interface ResponseDetail {
  eventSeq: number;
  version: number;
  contentHash: string;
  contactId: string;
  /** Contact name, or "Erased contact". */
  contactName: string;
  contactErased: boolean;
  requestId: string;
  submissionId: string;
  response: ResponseDecision;
  /** Dispute comment (erasable; null when absent or erased). */
  comment: string | null;
  recordedAt: Date;
}

export interface CandidateProvenance {
  candidateId: string;
  /** Null when the candidate row no longer exists. */
  extractionRunId: string | null;
  verification: "exact" | "offset_corrected" | null;
  model: string | null;
  promptVersion: string | null;
  edited: boolean | null;
}

export interface VersionDetail {
  version: number;
  contentHash: string;
  statement: string;
  spans: SpanDetail[];
  manual: { enteredBy: string; enteredByName: string | null } | null;
  provenance: Provenance;
  candidate: CandidateProvenance | null;
  reasonCode: ReviseReason | null;
  /** Member explanation from `event_note` (revise). */
  note: string | null;
  occurredAt: Date;
  recordedAt: Date;
  eventSeq: number;
  /** Status from this version's own responses (latest per contact, D-009). */
  status: ItemStatus;
  responses: ResponseDetail[];
}

export interface ItemDetail {
  id: string;
  shortId: string;
  kind: Kind;
  currentVersion: number;
  status: ItemStatus;
  lifecycle: ItemLifecycle;
  supersededBy: ItemRef | null;
  needsReview: boolean;
  reviewReasons: { upstreamItemId: string; upstreamShortId: string | null; cause: ReviewCause; seq: number }[];
  createdAt: Date;
  updatedAt: Date;
  lastSeq: number;
  /** Oldest first. */
  versions: VersionDetail[];
  /** Upstream items this item depends on. */
  dependencies: (ItemRef & { addedSeq: number })[];
  /** Items that depend on this one. */
  dependents: (ItemRef & { addedSeq: number })[];
}

interface StoredSpan {
  source_id: string;
  source_sha256: string;
  start: number;
  end: number;
  carried: boolean;
}

function versionStatusOf(responses: readonly ResponseDetail[], version: number, contentHash: string): ItemStatus {
  const latest = new Map<string, ResponseDetail>();
  for (const r of responses) if (r.version === version && r.contentHash === contentHash) latest.set(r.contactId, r);
  const values = [...latest.values()].map((r) => r.response);
  if (values.includes("disputed")) return "disputed";
  if (values.includes("confirmed")) return "confirmed";
  return "pending";
}

async function itemRefs(tx: Tx, ids: readonly string[]): Promise<Map<string, ItemRef>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      id: item.id,
      shortId: item.shortId,
      kind: item.kind,
      currentVersion: item.currentVersion,
      status: item.status,
      lifecycle: item.lifecycle,
      statement: itemVersion.statement,
    })
    .from(item)
    .innerJoin(itemVersion, and(eq(itemVersion.itemId, item.id), eq(itemVersion.version, item.currentVersion)))
    .where(inArray(item.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Full item view: versions (spans with verified quotes and source date/title, manual author,
 * candidate provenance, notes, responses with contact names or "Erased contact" and comments),
 * dependencies and dependents. `itemRef` is the item id or its short id (`HALV-R7`).
 */
export async function getItemDetail(tx: Tx, engagementId: string, itemRef: string): Promise<ItemDetail | null> {
  const [row] = await tx
    .select()
    .from(item)
    .where(and(eq(item.engagementId, engagementId), UUID_PATTERN.test(itemRef) ? eq(item.id, itemRef) : eq(item.shortId, itemRef)));
  if (!row) return null;

  const [versions, responses, deps, dependents] = await Promise.all([
    tx.select().from(itemVersion).where(eq(itemVersion.itemId, row.id)).orderBy(asc(itemVersion.version)),
    tx.select().from(itemResponse).where(and(eq(itemResponse.engagementId, engagementId), eq(itemResponse.itemId, row.id))).orderBy(asc(itemResponse.eventSeq)),
    tx.select().from(itemDependency).where(eq(itemDependency.itemId, row.id)),
    tx.select().from(itemDependency).where(eq(itemDependency.dependsOnItemId, row.id)),
  ]);

  const spansOf = (v: (typeof versions)[number]) => v.spans as StoredSpan[];
  const sourceIds = [...new Set(versions.flatMap((v) => spansOf(v).map((s) => s.source_id)))];
  const contactIds = [...new Set(responses.map((r) => r.contactId))];
  const seqs = [...versions.map((v) => v.eventSeq), ...responses.map((r) => r.eventSeq)];
  const candidateIds = versions.map((v) => (v.provenance as Provenance).candidate_id).filter((id): id is string => id !== undefined);
  const enteredBy = versions.map((v) => (v.manual as { entered_by: string } | null)?.entered_by).filter((id): id is string => id !== undefined);
  const reviewReasons = row.reviewReasons as { upstream_item_id: string; cause: ReviewCause; seq: number }[];

  const [sources, contents, contacts, eventIds, candidates, users, refs] = await Promise.all([
    sourceIds.length ? tx.select().from(source).where(inArray(source.id, sourceIds)) : [],
    sourceIds.length
      ? tx.select({ sourceId: sourceContent.sourceId, title: sourceContent.title, text: sourceContent.text }).from(sourceContent).where(inArray(sourceContent.sourceId, sourceIds))
      : [],
    contactIds.length
      ? tx
          .select({ id: clientContact.id, erasedAt: clientContact.erasedAt, name: contactPii.name })
          .from(clientContact)
          .leftJoin(contactPii, eq(contactPii.contactId, clientContact.id))
          .where(inArray(clientContact.id, contactIds))
      : [],
    tx.select({ id: event.id, seq: event.seq }).from(event).where(and(eq(event.engagementId, engagementId), inArray(event.seq, seqs))),
    candidateIds.length
      ? tx.select({ id: candidate.id, extractionRunId: candidate.extractionRunId, verification: candidate.verification }).from(candidate).where(inArray(candidate.id, candidateIds))
      : [],
    enteredBy.length ? tx.select({ id: appUser.id, name: appUser.name }).from(appUser).where(inArray(appUser.id, [...new Set(enteredBy)])) : [],
    itemRefs(tx, [
      ...deps.map((d) => d.dependsOnItemId),
      ...dependents.map((d) => d.itemId),
      ...reviewReasons.map((r) => r.upstream_item_id),
      ...(row.supersededBy ? [row.supersededBy] : []),
    ]),
  ]);

  const idBySeq = new Map(eventIds.map((e) => [e.seq, e.id]));
  const ids = [...idBySeq.values()];
  const [notes, comments] = ids.length
    ? await Promise.all([
        tx.select().from(eventNote).where(inArray(eventNote.eventId, ids)),
        tx.select({ eventId: responseComment.eventId, comment: responseComment.comment }).from(responseComment).where(inArray(responseComment.eventId, ids)),
      ])
    : [[], []];
  const noteByEvent = new Map(notes.map((n) => [n.eventId, n.note]));
  const commentByEvent = new Map(comments.map((c) => [c.eventId, c.comment]));
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const contentById = new Map(contents.map((c) => [c.sourceId, { title: c.title, text: c.text, sha: sha256Hex(c.text) }]));
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  const candidateById = new Map(candidates.map((c) => [c.id, c]));
  const userName = new Map(users.map((u) => [u.id, u.name]));

  const responseDetails: ResponseDetail[] = responses.map((r) => {
    const contact = contactById.get(r.contactId);
    const erased = !contact || contact.erasedAt !== null || contact.name === null;
    const eventId = idBySeq.get(r.eventSeq);
    return {
      eventSeq: r.eventSeq,
      version: r.version,
      contentHash: r.contentHash,
      contactId: r.contactId,
      contactName: erased ? ERASED_CONTACT_NAME : contact.name!,
      contactErased: erased,
      requestId: r.requestId,
      submissionId: r.submissionId,
      response: r.response,
      comment: eventId === undefined ? null : (commentByEvent.get(eventId) ?? null),
      recordedAt: r.recordedAt,
    };
  });

  const versionDetails: VersionDetail[] = versions.map((v) => {
    const provenance = v.provenance as Provenance;
    const manual = v.manual as { entered_by: string } | null;
    const spans: SpanDetail[] = spansOf(v).map((s) => {
      const src = sourceById.get(s.source_id);
      const content = contentById.get(s.source_id);
      const verified = content !== undefined && content.sha === s.source_sha256 && s.end <= content.text.length;
      return {
        sourceId: s.source_id,
        sourceSha256: s.source_sha256,
        start: s.start,
        end: s.end,
        carried: s.carried,
        quote: verified ? content.text.slice(s.start, s.end) : null,
        quoteState: verified ? "verified" : src?.redactedAt ? "redacted" : "unavailable",
        sourceType: src?.sourceType ?? null,
        sourceTitle: content?.title ?? null,
        sourceOccurredAt: src?.occurredAt ?? null,
        sourceRedactedAt: src?.redactedAt ?? null,
      };
    });
    const cand = provenance.candidate_id ? candidateById.get(provenance.candidate_id) : undefined;
    const eventId = idBySeq.get(v.eventSeq);
    const own = responseDetails.filter((r) => r.version === v.version);
    return {
      version: v.version,
      contentHash: v.contentHash,
      statement: v.statement,
      spans,
      manual: manual ? { enteredBy: manual.entered_by, enteredByName: userName.get(manual.entered_by) ?? null } : null,
      provenance,
      candidate: provenance.candidate_id
        ? {
            candidateId: provenance.candidate_id,
            extractionRunId: cand?.extractionRunId ?? null,
            verification: cand?.verification ?? null,
            model: provenance.model ?? null,
            promptVersion: provenance.prompt_version ?? null,
            edited: provenance.edited ?? null,
          }
        : null,
      reasonCode: v.reasonCode,
      note: eventId === undefined ? null : (noteByEvent.get(eventId) ?? null),
      occurredAt: v.occurredAt,
      recordedAt: v.recordedAt,
      eventSeq: v.eventSeq,
      status: versionStatusOf(own, v.version, v.contentHash),
      responses: own,
    };
  });

  const withSeq = (id: string, addedSeq: number) => {
    const ref = refs.get(id);
    return ref ? [{ ...ref, addedSeq }] : [];
  };
  return {
    id: row.id,
    shortId: row.shortId,
    kind: row.kind,
    currentVersion: row.currentVersion,
    status: row.status,
    lifecycle: row.lifecycle,
    supersededBy: row.supersededBy ? (refs.get(row.supersededBy) ?? null) : null,
    needsReview: row.needsReview,
    reviewReasons: reviewReasons.map((r) => ({
      upstreamItemId: r.upstream_item_id,
      upstreamShortId: refs.get(r.upstream_item_id)?.shortId ?? null,
      cause: r.cause,
      seq: r.seq,
    })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastSeq: row.lastSeq,
    versions: versionDetails,
    dependencies: deps.flatMap((d) => withSeq(d.dependsOnItemId, d.addedSeq)).sort(compareItemRows),
    dependents: dependents.flatMap((d) => withSeq(d.itemId, d.addedSeq)).sort(compareItemRows),
  };
}
