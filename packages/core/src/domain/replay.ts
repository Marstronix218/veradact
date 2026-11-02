/**
 * Replay (ARCHITECTURE §5.4, D-010). Pure over `StoredEvent[]` in seq order.
 *
 * - `asOf(events, T, 'known')`  — fold of every event with `recordedAt <= T`.
 * - `asOf(events, T, 'agreed')` — active items whose current version at T is confirmed, plus
 *   `previouslyAgreed` (an earlier version was confirmed, the current one is pending/disputed) and
 *   `notConfirmed` (every other active item: the "do not build" list).
 * - `diff(events, T1, T2)`      — per-item comparison of the known views plus the events in (T1, T2].
 * - `decisionContext(events, itemId, version?)` — known view through the seq of that version's
 *   event (inclusive), plus each dependency's version and status at that point.
 */
import type { Kind, Manual, Provenance, ReviseReason, StoredEvent, SupersedeReason, WithdrawReason } from "./events";
import { KINDS } from "./events";
import { fold } from "./reducer";
import {
  currentVersionOf,
  latestResponsesByContact,
  spansWithCarried,
  versionStatus,
  type EngagementInfo,
  type EngagementState,
  type ItemLifecycle,
  type ItemResponse,
  type ItemState,
  type ItemStatus,
  type ItemVersion,
  type ResponseDecision,
  type ReviewCause,
  type SpanWithCarried,
} from "./state";

export type ReplayView = "known" | "agreed";

export interface ViewHead {
  seq: number;
  hash: string;
  recordedAt: Date | null;
}

export interface ResponseView {
  seq: number;
  contactId: string;
  /** The contact has been erased (as of the view): render "Erased contact". */
  contactErased: boolean;
  requestId: string;
  submissionId: string;
  response: ResponseDecision;
  recordedAt: Date;
  evidenceCommitment: string;
  commentCommitment: string | null;
}

export interface VersionView {
  version: number;
  contentHash: string;
  statement: string;
  spans: SpanWithCarried[];
  manual: Manual | null;
  provenance: Provenance;
  reasonCode: ReviseReason | null;
  occurredAt: Date;
  recordedAt: Date;
  seq: number;
  /** Status of this version from its own responses (latest per contact, D-009). */
  status: ItemStatus;
  /** Every response on this version, in seq order. */
  responses: ResponseView[];
}

export interface ReviewReasonView {
  upstreamItemId: string;
  upstreamShortId: string | null;
  cause: ReviewCause;
  seq: number;
}

export interface DependencyRef {
  itemId: string;
  /** Null when the upstream item is unknown at this point (cannot happen in a valid log). */
  shortId: string | null;
  kind: Kind | null;
  currentVersion: number | null;
  status: ItemStatus | null;
  lifecycle: ItemLifecycle | null;
  addedSeq: number;
}

export interface KnownItem {
  itemId: string;
  shortId: string;
  kind: Kind;
  currentVersion: number;
  status: ItemStatus;
  lifecycle: ItemLifecycle;
  supersededBy: string | null;
  supersededByShortId: string | null;
  needsReview: boolean;
  reviewReasons: ReviewReasonView[];
  dependsOn: DependencyRef[];
  createdAt: Date;
  updatedAt: Date;
  lastSeq: number;
  current: VersionView;
  /** All versions recorded so far, oldest first. */
  versions: VersionView[];
}

export interface KnownView {
  view: "known";
  asOf: Date;
  head: ViewHead;
  engagement: EngagementInfo | null;
  /** Items in display order: kind (problem → requirement), then creation order. */
  items: KnownItem[];
  /** The folded state itself (equals `fold(events with recordedAt <= asOf)`). */
  state: EngagementState;
}

export interface Confirmation {
  contactId: string;
  contactErased: boolean;
  recordedAt: Date;
  requestId: string;
  submissionId: string;
  seq: number;
}

export interface AgreedItem {
  itemId: string;
  shortId: string;
  kind: Kind;
  version: number;
  contentHash: string;
  statement: string;
  spans: SpanWithCarried[];
  manual: Manual | null;
  provenance: Provenance;
  /** When the confirmed version was said (source date) and recorded. */
  occurredAt: Date;
  recordedAt: Date;
  /** Latest response per contact on this version (all confirmations, since status is confirmed). */
  confirmations: Confirmation[];
  dependsOn: DependencyRef[];
  needsReview: boolean;
  reviewReasons: ReviewReasonView[];
}

export interface PreviouslyAgreedItem {
  itemId: string;
  shortId: string;
  kind: Kind;
  currentVersion: number;
  currentStatus: "pending" | "disputed";
  currentStatement: string;
  agreedVersion: number;
  agreedContentHash: string;
  agreedStatement: string;
  confirmations: Confirmation[];
}

export interface NotConfirmedItem {
  itemId: string;
  shortId: string;
  kind: Kind;
  currentVersion: number;
  status: "pending" | "disputed";
  statement: string;
  /** An earlier version was confirmed (the item is also in `previouslyAgreed`). */
  revisionPending: boolean;
  needsReview: boolean;
}

export interface AgreedView {
  view: "agreed";
  asOf: Date;
  head: ViewHead;
  engagement: EngagementInfo | null;
  items: AgreedItem[];
  previouslyAgreed: PreviouslyAgreedItem[];
  notConfirmed: NotConfirmedItem[];
}

// ---------------------------------------------------------------------------------------------
// Helpers

const KIND_INDEX: Record<Kind, number> = Object.fromEntries(KINDS.map((k, i) => [k, i])) as Record<Kind, number>;

/** Display order: kind (problem, constraint, assumption, decision, requirement), then creation seq. */
export function compareItemsForDisplay(a: ItemState, b: ItemState): number {
  return KIND_INDEX[a.kind] - KIND_INDEX[b.kind] || (a.versions[0]?.seq ?? 0) - (b.versions[0]?.seq ?? 0);
}

function sortedItems(state: EngagementState): ItemState[] {
  return [...state.items.values()].sort(compareItemsForDisplay);
}

function headOf(state: EngagementState): ViewHead {
  return { seq: state.headSeq, hash: state.headHash, recordedAt: state.headRecordedAt };
}

function responseView(state: EngagementState, r: ItemResponse): ResponseView {
  return {
    seq: r.seq,
    contactId: r.contactId,
    contactErased: state.erasedContacts.has(r.contactId),
    requestId: r.requestId,
    submissionId: r.submissionId,
    response: r.response,
    recordedAt: r.recordedAt,
    evidenceCommitment: r.evidenceCommitment,
    commentCommitment: r.commentCommitment,
  };
}

function versionView(state: EngagementState, item: ItemState, v: ItemVersion): VersionView {
  return {
    version: v.version,
    contentHash: v.contentHash,
    statement: v.statement,
    spans: spansWithCarried(item, v.version),
    manual: v.manual,
    provenance: v.provenance,
    reasonCode: v.reasonCode,
    occurredAt: v.occurredAt,
    recordedAt: v.recordedAt,
    seq: v.seq,
    status: versionStatus(item.responses, v.version, v.contentHash),
    responses: item.responses
      .filter((r) => r.version === v.version && r.contentHash === v.contentHash)
      .map((r) => responseView(state, r)),
  };
}

function reviewReasonViews(state: EngagementState, item: ItemState): ReviewReasonView[] {
  return item.reviewReasons.map((r) => ({
    upstreamItemId: r.upstreamItemId,
    upstreamShortId: state.items.get(r.upstreamItemId)?.shortId ?? null,
    cause: r.cause,
    seq: r.seq,
  }));
}

function dependencyRefs(state: EngagementState, item: ItemState): DependencyRef[] {
  return [...item.dependsOn]
    .map(([itemId, addedSeq]) => {
      const dep = state.items.get(itemId);
      return {
        itemId,
        shortId: dep?.shortId ?? null,
        kind: dep?.kind ?? null,
        currentVersion: dep?.currentVersion ?? null,
        status: dep?.status ?? null,
        lifecycle: dep?.lifecycle ?? null,
        addedSeq,
      };
    })
    .sort((a, b) => a.addedSeq - b.addedSeq || (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
}

function knownItem(state: EngagementState, item: ItemState): KnownItem {
  const versions = item.versions.map((v) => versionView(state, item, v));
  const current = versions.find((v) => v.version === item.currentVersion) ?? versions[versions.length - 1]!;
  return {
    itemId: item.id,
    shortId: item.shortId,
    kind: item.kind,
    currentVersion: item.currentVersion,
    status: item.status,
    lifecycle: item.lifecycle,
    supersededBy: item.supersededBy,
    supersededByShortId: item.supersededBy ? (state.items.get(item.supersededBy)?.shortId ?? null) : null,
    needsReview: item.needsReview,
    reviewReasons: reviewReasonViews(state, item),
    dependsOn: dependencyRefs(state, item),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    lastSeq: item.lastSeq,
    current,
    versions,
  };
}

function confirmationsFor(state: EngagementState, item: ItemState, v: ItemVersion): Confirmation[] {
  return latestResponsesByContact(item.responses, v.version, v.contentHash)
    .filter((r) => r.response === "confirmed")
    .map((r) => ({
      contactId: r.contactId,
      contactErased: state.erasedContacts.has(r.contactId),
      recordedAt: r.recordedAt,
      requestId: r.requestId,
      submissionId: r.submissionId,
      seq: r.seq,
    }));
}

/** The latest version before the current one whose own status is `confirmed`. */
function lastAgreedEarlierVersion(item: ItemState): ItemVersion | undefined {
  for (let i = item.versions.length - 1; i >= 0; i--) {
    const v = item.versions[i]!;
    if (v.version >= item.currentVersion) continue;
    if (versionStatus(item.responses, v.version, v.contentHash) === "confirmed") return v;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Views

/** Known view of an already-folded state. */
export function knownViewOf(state: EngagementState, asOfTime: Date): KnownView {
  return {
    view: "known",
    asOf: asOfTime,
    head: headOf(state),
    engagement: state.engagement,
    items: sortedItems(state).map((item) => knownItem(state, item)),
    state,
  };
}

/** Agreed view of an already-folded state (D-010). */
export function agreedViewOf(state: EngagementState, asOfTime: Date): AgreedView {
  const items: AgreedItem[] = [];
  const previouslyAgreed: PreviouslyAgreedItem[] = [];
  const notConfirmed: NotConfirmedItem[] = [];
  for (const item of sortedItems(state)) {
    if (item.lifecycle !== "active") continue;
    const current = currentVersionOf(item);
    if (item.status === "confirmed") {
      items.push({
        itemId: item.id,
        shortId: item.shortId,
        kind: item.kind,
        version: current.version,
        contentHash: current.contentHash,
        statement: current.statement,
        spans: spansWithCarried(item, current.version),
        manual: current.manual,
        provenance: current.provenance,
        occurredAt: current.occurredAt,
        recordedAt: current.recordedAt,
        confirmations: confirmationsFor(state, item, current),
        dependsOn: dependencyRefs(state, item),
        needsReview: item.needsReview,
        reviewReasons: reviewReasonViews(state, item),
      });
      continue;
    }
    const earlier = lastAgreedEarlierVersion(item);
    if (earlier) {
      previouslyAgreed.push({
        itemId: item.id,
        shortId: item.shortId,
        kind: item.kind,
        currentVersion: current.version,
        currentStatus: item.status,
        currentStatement: current.statement,
        agreedVersion: earlier.version,
        agreedContentHash: earlier.contentHash,
        agreedStatement: earlier.statement,
        confirmations: confirmationsFor(state, item, earlier),
      });
    }
    notConfirmed.push({
      itemId: item.id,
      shortId: item.shortId,
      kind: item.kind,
      currentVersion: current.version,
      status: item.status,
      statement: current.statement,
      revisionPending: earlier !== undefined,
      needsReview: item.needsReview,
    });
  }
  return { view: "agreed", asOf: asOfTime, head: headOf(state), engagement: state.engagement, items, previouslyAgreed, notConfirmed };
}

function foldUntil(events: readonly StoredEvent[], t: Date): EngagementState {
  const cutoff = t.getTime();
  return fold(events.filter((e) => e.recordedAt.getTime() <= cutoff));
}

export function asOf(events: readonly StoredEvent[], t: Date, view: "known"): KnownView;
export function asOf(events: readonly StoredEvent[], t: Date, view: "agreed"): AgreedView;
export function asOf(events: readonly StoredEvent[], t: Date, view: ReplayView): KnownView | AgreedView;
export function asOf(events: readonly StoredEvent[], t: Date, view: ReplayView): KnownView | AgreedView {
  const state = foldUntil(events, t);
  return view === "known" ? knownViewOf(state, t) : agreedViewOf(state, t);
}

// ---------------------------------------------------------------------------------------------
// Diff

export interface ItemSnapshot {
  version: number;
  contentHash: string;
  statement: string;
  status: ItemStatus;
  lifecycle: ItemLifecycle;
  needsReview: boolean;
}

export interface ItemChange {
  itemId: string;
  shortId: string;
  kind: Kind;
  /** Null when the item did not exist at T1. */
  before: ItemSnapshot | null;
  after: ItemSnapshot;
}

export interface AddedItem {
  itemId: string;
  shortId: string;
  kind: Kind;
  /** Version, statement and status at T2. */
  version: number;
  statement: string;
  status: ItemStatus;
  lifecycle: ItemLifecycle;
  seq: number;
  recordedAt: Date;
}

export interface RevisedItem {
  itemId: string;
  shortId: string;
  kind: Kind;
  fromVersion: number;
  toVersion: number;
  fromContentHash: string;
  toContentHash: string;
  fromStatement: string;
  toStatement: string;
}

export interface ResponseEventRef {
  itemId: string;
  shortId: string | null;
  version: number;
  contentHash: string;
  contactId: string;
  contactErased: boolean;
  requestId: string;
  recordedAt: Date;
  seq: number;
}

export interface SupersededItemRef {
  itemId: string;
  shortId: string | null;
  supersededBy: string;
  supersededByShortId: string | null;
  reasonCode: SupersedeReason;
  recordedAt: Date;
  seq: number;
}

export interface WithdrawnItemRef {
  itemId: string;
  shortId: string | null;
  reasonCode: WithdrawReason;
  recordedAt: Date;
  seq: number;
}

export interface ReplayDiff {
  from: Date;
  to: Date;
  fromHead: ViewHead;
  toHead: ViewHead;
  /** Items created in (T1, T2], with their state at T2. */
  added: AddedItem[];
  /** Items that existed at T1 and have a different current version at T2. */
  revised: RevisedItem[];
  /** `item_confirmed` / `item_disputed` events recorded in (T1, T2], in seq order. */
  confirmed: ResponseEventRef[];
  disputed: ResponseEventRef[];
  superseded: SupersededItemRef[];
  withdrawn: WithdrawnItemRef[];
  /** Every item whose snapshot differs between T1 and T2 (or is new), in display order. */
  changes: ItemChange[];
}

function snapshot(item: ItemState): ItemSnapshot {
  const v = currentVersionOf(item);
  return {
    version: v.version,
    contentHash: v.contentHash,
    statement: v.statement,
    status: item.status,
    lifecycle: item.lifecycle,
    needsReview: item.needsReview,
  };
}

function sameSnapshot(a: ItemSnapshot, b: ItemSnapshot): boolean {
  return (
    a.version === b.version &&
    a.contentHash === b.contentHash &&
    a.status === b.status &&
    a.lifecycle === b.lifecycle &&
    a.needsReview === b.needsReview
  );
}

export function diff(events: readonly StoredEvent[], from: Date, to: Date): ReplayDiff {
  if (from.getTime() > to.getTime()) throw new RangeError("diff: `from` must not be after `to`");
  const before = foldUntil(events, from);
  const after = foldUntil(events, to);
  const shortIdOf = (id: string) => after.items.get(id)?.shortId ?? null;

  const added: AddedItem[] = [];
  const revised: RevisedItem[] = [];
  const changes: ItemChange[] = [];
  for (const item of sortedItems(after)) {
    const prev = before.items.get(item.id);
    const now = snapshot(item);
    if (!prev) {
      added.push({
        itemId: item.id,
        shortId: item.shortId,
        kind: item.kind,
        version: now.version,
        statement: now.statement,
        status: now.status,
        lifecycle: now.lifecycle,
        seq: item.versions[0]?.seq ?? item.lastSeq,
        recordedAt: item.createdAt,
      });
      changes.push({ itemId: item.id, shortId: item.shortId, kind: item.kind, before: null, after: now });
      continue;
    }
    const was = snapshot(prev);
    if (was.version !== now.version) {
      revised.push({
        itemId: item.id,
        shortId: item.shortId,
        kind: item.kind,
        fromVersion: was.version,
        toVersion: now.version,
        fromContentHash: was.contentHash,
        toContentHash: now.contentHash,
        fromStatement: was.statement,
        toStatement: now.statement,
      });
    }
    if (!sameSnapshot(was, now)) changes.push({ itemId: item.id, shortId: item.shortId, kind: item.kind, before: was, after: now });
  }

  const confirmed: ResponseEventRef[] = [];
  const disputed: ResponseEventRef[] = [];
  const superseded: SupersededItemRef[] = [];
  const withdrawn: WithdrawnItemRef[] = [];
  const lo = from.getTime();
  const hi = to.getTime();
  for (const e of events) {
    const t = e.recordedAt.getTime();
    if (t <= lo || t > hi) continue;
    switch (e.type) {
      case "item_confirmed":
      case "item_disputed": {
        const p = e.payload;
        (e.type === "item_confirmed" ? confirmed : disputed).push({
          itemId: p.item_id,
          shortId: shortIdOf(p.item_id),
          version: p.version,
          contentHash: p.content_hash,
          contactId: p.contact_id,
          contactErased: after.erasedContacts.has(p.contact_id),
          requestId: p.request_id,
          recordedAt: e.recordedAt,
          seq: e.seq,
        });
        break;
      }
      case "item_superseded":
        superseded.push({
          itemId: e.payload.item_id,
          shortId: shortIdOf(e.payload.item_id),
          supersededBy: e.payload.superseded_by_item_id,
          supersededByShortId: shortIdOf(e.payload.superseded_by_item_id),
          reasonCode: e.payload.reason_code,
          recordedAt: e.recordedAt,
          seq: e.seq,
        });
        break;
      case "item_withdrawn":
        withdrawn.push({
          itemId: e.payload.item_id,
          shortId: shortIdOf(e.payload.item_id),
          reasonCode: e.payload.reason_code,
          recordedAt: e.recordedAt,
          seq: e.seq,
        });
        break;
      default:
        break;
    }
  }

  return { from, to, fromHead: headOf(before), toHead: headOf(after), added, revised, confirmed, disputed, superseded, withdrawn, changes };
}

// ---------------------------------------------------------------------------------------------
// Decision context

export interface DependencyContext {
  itemId: string;
  shortId: string | null;
  kind: Kind | null;
  /** Current version, its hash and statement, status and lifecycle at the cut. */
  version: number | null;
  contentHash: string | null;
  statement: string | null;
  status: ItemStatus | null;
  lifecycle: ItemLifecycle | null;
  needsReview: boolean | null;
  addedSeq: number;
}

export interface DecisionContext {
  itemId: string;
  shortId: string;
  kind: Kind;
  version: number;
  /** Seq, recorded and occurred time of the event that created this version (the cut, inclusive). */
  seq: number;
  recordedAt: Date;
  occurredAt: Date;
  /** The item as known at the cut. */
  item: KnownItem;
  /** Each dependency of the item at the cut, with its version and status at that point. */
  dependencies: DependencyContext[];
  /** The whole known view at the cut (`asOf` = recordedAt of the cut event). */
  known: KnownView;
}

/**
 * "What did we know when we made decision X (at version v)?" Returns null when the item or
 * version does not exist in `events`. Defaults to the item's latest version in the log.
 */
export function decisionContext(events: readonly StoredEvent[], itemId: string, version?: number): DecisionContext | null {
  let cut: StoredEvent | undefined;
  for (const e of events) {
    if (e.type === "item_created" && e.payload.item_id === itemId) {
      if (version === undefined || version === e.payload.version) cut = e;
    } else if (e.type === "item_revised" && e.payload.item_id === itemId) {
      if (version === undefined || version === e.payload.version) cut = e;
    }
    if (cut && version !== undefined) break;
  }
  if (!cut) return null;
  const cutSeq = cut.seq;
  const state = fold(events.filter((e) => e.seq <= cutSeq));
  const item = state.items.get(itemId);
  if (!item) return null;
  const known = knownViewOf(state, cut.recordedAt);
  const knownX = known.items.find((i) => i.itemId === itemId)!;
  const dependencies: DependencyContext[] = knownX.dependsOn.map((ref) => {
    const dep = state.items.get(ref.itemId);
    const v = dep ? currentVersionOf(dep) : undefined;
    return {
      itemId: ref.itemId,
      shortId: dep?.shortId ?? null,
      kind: dep?.kind ?? null,
      version: v?.version ?? null,
      contentHash: v?.contentHash ?? null,
      statement: v?.statement ?? null,
      status: dep?.status ?? null,
      lifecycle: dep?.lifecycle ?? null,
      needsReview: dep?.needsReview ?? null,
      addedSeq: ref.addedSeq,
    };
  });
  return {
    itemId,
    shortId: item.shortId,
    kind: item.kind,
    version: item.currentVersion,
    seq: cut.seq,
    recordedAt: cut.recordedAt,
    occurredAt: cut.occurredAt,
    item: knownX,
    dependencies,
    known,
  };
}
