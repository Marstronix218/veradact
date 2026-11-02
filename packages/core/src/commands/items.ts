// Item commands (ARCHITECTURE §3, §5.2, §9.4; D-011, D-023, D-024). Each validates against the
// folded state under the engagement lock before producing a draft.
import { randomUUID } from "node:crypto";
import {
  canDependOn,
  currentVersionOf,
  itemContentHash,
  KINDS,
  nextShortId,
  wouldCreateCycle,
  type EngagementState,
  type ItemState,
  type Kind,
  type Manual,
  type Provenance,
  type ReviseReason,
  type Span,
  type StoredEvent,
  type SupersedeReason,
  type WithdrawReason,
} from "../domain";
import { DomainError } from "../errors";
import { appendEvents, type AppendResult } from "../store";
import { fixedClock, lockAndLoad, runInTenant, userActor, type CommandContext } from "./context";
import { cleanNote, writeNote } from "./notes";
import { resolveSpans, sameSpan, type SpanInput } from "./spans";

const STATEMENT_MAX = 2000;
const MANUAL_PROVENANCE: Provenance = { via: "manual" };

export interface ItemEventResult {
  events: StoredEvent[];
  eventIds: number[];
  state: EngagementState;
}

export interface ItemVersionResult extends ItemEventResult {
  itemId: string;
  shortId: string;
  version: number;
  contentHash: string;
}

function checkStatement(statement: string): void {
  if (statement.trim() === "" || statement.length > STATEMENT_MAX) throw new DomainError("invalid_statement");
}

function checkDate(date: Date | undefined): void {
  if (date !== undefined && (!(date instanceof Date) || Number.isNaN(date.getTime()))) throw new DomainError("invalid_source_date");
}

/** The item, or `item_not_found` / `item_not_active`. */
export function requireActiveItem(state: EngagementState, itemId: string): ItemState {
  const item = state.items.get(itemId);
  if (!item) throw new DomainError("item_not_found", { itemId });
  if (item.lifecycle !== "active") throw new DomainError("item_not_active", { itemId });
  return item;
}

/** `occurred_at` of an item version: the first cited source's date, else the member-supplied date. */
function versionOccurredAt(state: EngagementState, spans: readonly Span[], manualDate: Date | undefined): Date | undefined {
  const first = spans[0];
  if (first) return state.sources.get(first.source_id)?.occurredAt;
  return manualDate;
}

function result(appended: AppendResult): ItemEventResult {
  return { events: appended.events, eventIds: appended.eventIds, state: appended.state };
}

export interface CreateItemInput {
  engagementId: string;
  /** Defaults to a random UUID. */
  itemId?: string;
  kind: Kind;
  statement: string;
  /** Source quotes; verified against `source_content`. */
  spans?: readonly SpanInput[];
  /** Entered without a source: records `manual: { entered_by: userId }`. Exclusive with spans. */
  manual?: boolean;
  /** Upstream items (only decisions and requirements may depend on others). */
  dependsOn?: readonly string[];
  /** Defaults to `{ via: 'manual' }`; the extraction flow passes the candidate's provenance. */
  provenance?: Provenance;
  /** Member-supplied date for manual items (sourced items use the source's date). */
  occurredAt?: Date;
}

/** Appends `item_created` (version 1) with an allocated short id and the content hash. */
export async function createItem(ctx: CommandContext, input: CreateItemInput): Promise<ItemVersionResult> {
  if (!(KINDS as readonly string[]).includes(input.kind)) throw new DomainError("invalid_event", { type: "item_created", issues: ["payload.kind: invalid kind"] });
  checkStatement(input.statement);
  checkDate(input.occurredAt);
  const spanInputs = input.spans ?? [];
  const manualFlag = input.manual === true;
  if (spanInputs.length >= 1 === manualFlag) throw new DomainError("sourced_or_manual", { problem: manualFlag ? "both" : "neither" });
  const itemId = input.itemId ?? randomUUID();

  return runInTenant(ctx, async (tx) => {
    const { state, engagement } = await lockAndLoad(tx, input.engagementId);
    if (state.items.has(itemId)) throw new DomainError("item_exists", { itemId });

    const dependsOn = [...new Set(input.dependsOn ?? [])];
    if (dependsOn.length > 0 && !canDependOn(input.kind)) throw new DomainError("dependency_kind_not_allowed", { kind: input.kind });
    for (const upstream of dependsOn) {
      const up = state.items.get(upstream);
      if (!up || up.lifecycle !== "active") throw new DomainError("dependency_target_invalid", { itemId: upstream });
    }

    const spans = await resolveSpans(tx, state, spanInputs);
    const manual: Manual | null = manualFlag ? { entered_by: ctx.userId } : null;
    const shortId = nextShortId(state, input.kind);
    const contentHash = itemContentHash({
      engagement_id: engagement.id,
      item_id: itemId,
      kind: input.kind,
      version: 1,
      statement: input.statement,
      spans,
      manual,
    });
    const occurredAt = versionOccurredAt(state, spans, input.occurredAt);
    const appended = await appendEvents(
      tx,
      input.engagementId,
      [
        {
          type: "item_created",
          actor: userActor(ctx.userId),
          ...(occurredAt ? { occurredAt } : {}),
          payload: {
            item_id: itemId,
            short_id: shortId,
            kind: input.kind,
            version: 1,
            statement: input.statement,
            spans,
            manual,
            depends_on: dependsOn,
            provenance: input.provenance ?? MANUAL_PROVENANCE,
            content_hash: contentHash,
          },
        },
      ],
      { clock: fixedClock(ctx.clock()), state },
    );
    return { ...result(appended), itemId, shortId, version: 1, contentHash };
  });
}

export interface ReviseItemInput {
  engagementId: string;
  itemId: string;
  statement: string;
  reasonCode: ReviseReason;
  /** Current-version spans to drop; every other current span is carried over unchanged. */
  removeSpans?: readonly { sourceId: string; start: number; end: number }[];
  /** New quotes to cite (verified like `createItem`'s). */
  addSpans?: readonly SpanInput[];
  /** The version the member edited; a different current version → `version_mismatch`. */
  expectedVersion?: number;
  /** Optional explanation, stored in `event_note`. */
  note?: string | null;
  /** Defaults to `{ via: 'manual' }`; the extraction flow passes the candidate's provenance. */
  provenance?: Provenance;
  /** Member-supplied date when the revision ends up manual (no spans). */
  occurredAt?: Date;
}

/**
 * Appends `item_revised` (version n+1, new pending version). Carried spans are copied unchanged —
 * no re-verification, so items whose source was redacted can still be revised. Zero spans ⇒
 * `manual: { entered_by: userId }`.
 */
export async function reviseItem(ctx: CommandContext, input: ReviseItemInput): Promise<ItemVersionResult> {
  checkStatement(input.statement);
  checkDate(input.occurredAt);
  const note = cleanNote(input.note);

  return runInTenant(ctx, async (tx) => {
    const { state, engagement } = await lockAndLoad(tx, input.engagementId);
    const item = requireActiveItem(state, input.itemId);
    const current = currentVersionOf(item);
    if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
      throw new DomainError("version_mismatch", { itemId: item.id, currentVersion: current.version });
    }

    const removals = input.removeSpans ?? [];
    for (const [index, r] of removals.entries()) {
      if (!current.spans.some((s) => sameSpan(s, { source_id: r.sourceId, start: r.start, end: r.end }))) {
        throw new DomainError("span_not_on_item", { itemId: item.id, index });
      }
    }
    const carried: Span[] = current.spans
      .filter((s) => !removals.some((r) => sameSpan(s, { source_id: r.sourceId, start: r.start, end: r.end })))
      .map((s) => ({ source_id: s.source_id, source_sha256: s.source_sha256, start: s.start, end: s.end }));
    const added = (await resolveSpans(tx, state, input.addSpans ?? [])).filter((s) => !carried.some((c) => sameSpan(c, s)));
    const spans = [...carried, ...added];
    const manual: Manual | null = spans.length === 0 ? { entered_by: ctx.userId } : null;
    const version = current.version + 1;
    const contentHash = itemContentHash({
      engagement_id: engagement.id,
      item_id: item.id,
      kind: item.kind,
      version,
      statement: input.statement,
      spans,
      manual,
    });
    const occurredAt = versionOccurredAt(state, spans, input.occurredAt);
    const appended = await appendEvents(
      tx,
      input.engagementId,
      [
        {
          type: "item_revised",
          actor: userActor(ctx.userId),
          ...(occurredAt ? { occurredAt } : {}),
          payload: {
            item_id: item.id,
            version,
            statement: input.statement,
            spans,
            manual,
            provenance: input.provenance ?? MANUAL_PROVENANCE,
            reason_code: input.reasonCode,
            content_hash: contentHash,
            previous_content_hash: current.contentHash,
          },
        },
      ],
      { clock: fixedClock(ctx.clock()), state },
    );
    await writeNote(tx, ctx.orgId, appended.eventIds[0]!, note);
    return { ...result(appended), itemId: item.id, shortId: item.shortId, version, contentHash };
  });
}

export interface SupersedeItemInput {
  engagementId: string;
  itemId: string;
  supersededByItemId: string;
  reasonCode: SupersedeReason;
  note?: string | null;
}

/** Appends `item_superseded`; both items must be active and different. Flags dependents. */
export async function supersedeItem(ctx: CommandContext, input: SupersedeItemInput): Promise<ItemEventResult> {
  const note = cleanNote(input.note);
  return runInTenant(ctx, async (tx) => {
    const { state } = await lockAndLoad(tx, input.engagementId);
    requireActiveItem(state, input.itemId);
    const by = state.items.get(input.supersededByItemId);
    if (input.supersededByItemId === input.itemId || !by || by.lifecycle !== "active") {
      throw new DomainError("supersede_target_invalid", { itemId: input.supersededByItemId });
    }
    const appended = await appendEvents(
      tx,
      input.engagementId,
      [
        {
          type: "item_superseded",
          actor: userActor(ctx.userId),
          payload: { item_id: input.itemId, superseded_by_item_id: input.supersededByItemId, reason_code: input.reasonCode },
        },
      ],
      { clock: fixedClock(ctx.clock()), state },
    );
    await writeNote(tx, ctx.orgId, appended.eventIds[0]!, note);
    return result(appended);
  });
}

export interface WithdrawItemInput {
  engagementId: string;
  itemId: string;
  reasonCode: WithdrawReason;
  note?: string | null;
}

/** Appends `item_withdrawn` for an active item. Flags dependents. */
export async function withdrawItem(ctx: CommandContext, input: WithdrawItemInput): Promise<ItemEventResult> {
  const note = cleanNote(input.note);
  return runInTenant(ctx, async (tx) => {
    const { state } = await lockAndLoad(tx, input.engagementId);
    requireActiveItem(state, input.itemId);
    const appended = await appendEvents(
      tx,
      input.engagementId,
      [{ type: "item_withdrawn", actor: userActor(ctx.userId), payload: { item_id: input.itemId, reason_code: input.reasonCode } }],
      { clock: fixedClock(ctx.clock()), state },
    );
    await writeNote(tx, ctx.orgId, appended.eventIds[0]!, note);
    return result(appended);
  });
}

export interface DependencyInput {
  engagementId: string;
  /** The dependent (a decision or requirement). */
  itemId: string;
  dependsOnItemId: string;
}

/** Appends `dependency_added` (D-024: dependent is an active decision/requirement; no cycles). */
export async function addDependency(ctx: CommandContext, input: DependencyInput): Promise<ItemEventResult> {
  return runInTenant(ctx, async (tx) => {
    const { state } = await lockAndLoad(tx, input.engagementId);
    const dependent = requireActiveItem(state, input.itemId);
    if (!canDependOn(dependent.kind)) throw new DomainError("dependency_kind_not_allowed", { kind: dependent.kind });
    const upstream = state.items.get(input.dependsOnItemId);
    if (input.dependsOnItemId === input.itemId) throw new DomainError("dependency_cycle", { itemId: input.itemId });
    if (!upstream || upstream.lifecycle !== "active") throw new DomainError("dependency_target_invalid", { itemId: input.dependsOnItemId });
    if (dependent.dependsOn.has(input.dependsOnItemId)) throw new DomainError("dependency_exists");
    if (wouldCreateCycle(state, input.itemId, input.dependsOnItemId)) throw new DomainError("dependency_cycle", { itemId: input.itemId });
    const appended = await appendEvents(
      tx,
      input.engagementId,
      [{ type: "dependency_added", actor: userActor(ctx.userId), payload: { item_id: input.itemId, depends_on_item_id: input.dependsOnItemId } }],
      { clock: fixedClock(ctx.clock()), state },
    );
    return result(appended);
  });
}

/** Appends `dependency_removed` for an existing edge of an active dependent. */
export async function removeDependency(ctx: CommandContext, input: DependencyInput): Promise<ItemEventResult> {
  return runInTenant(ctx, async (tx) => {
    const { state } = await lockAndLoad(tx, input.engagementId);
    const dependent = requireActiveItem(state, input.itemId);
    if (!dependent.dependsOn.has(input.dependsOnItemId)) throw new DomainError("dependency_not_found");
    const appended = await appendEvents(
      tx,
      input.engagementId,
      [{ type: "dependency_removed", actor: userActor(ctx.userId), payload: { item_id: input.itemId, depends_on_item_id: input.dependsOnItemId } }],
      { clock: fixedClock(ctx.clock()), state },
    );
    return result(appended);
  });
}

/** Appends `review_cleared` for an active item that needs review (D-011). */
export async function clearReview(ctx: CommandContext, input: { engagementId: string; itemId: string }): Promise<ItemEventResult> {
  return runInTenant(ctx, async (tx) => {
    const { state } = await lockAndLoad(tx, input.engagementId);
    const item = requireActiveItem(state, input.itemId);
    if (!item.needsReview) throw new DomainError("review_not_needed", { itemId: item.id });
    const appended = await appendEvents(
      tx,
      input.engagementId,
      [{ type: "review_cleared", actor: userActor(ctx.userId), payload: { item_id: item.id } }],
      { clock: fixedClock(ctx.clock()), state },
    );
    return result(appended);
  });
}
