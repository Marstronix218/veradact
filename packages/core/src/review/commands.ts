// Review queue decisions (ARCHITECTURE §9.4, D-004, CLAUDE.md invariant 10). Accepting a candidate
// is the human action that puts it in the ledger: `item_created` (or `item_revised` for a revision
// proposal) with `provenance.via = 'ai_candidate'`, in the same transaction that marks the row.
import { and, eq } from "drizzle-orm";
import { candidate, extractionRun, type Tx } from "@veradact/db";
import {
  canDependOn,
  currentVersionOf,
  KINDS,
  UUID_PATTERN,
  wouldCreateCycle,
  type EngagementState,
  type ItemState,
  type Kind,
  type Provenance,
} from "../domain";
import { addDependency, createItem, lockAndLoad, reviseItem, runInTenant, type CommandContext } from "../commands";
import { DomainError, ReviewError } from "../errors";

export interface AcceptCandidateInput {
  candidateId: string;
  /** When given, the candidate must belong to this engagement. */
  engagementId?: string;
  /**
   * Member edits before accepting. `dependsOn` replaces the suggestions and takes the same
   * references: short ids (`HALV-A3`), `#n` (same-run candidate ordinals) or item ids.
   */
  edits?: { statement?: string; kind?: Kind; dependsOn?: readonly string[] };
}

/** A dependency suggestion that was not applied, or a revision that became a new item. */
export type AcceptNote =
  | { code: "dependency_unresolved" | "dependency_not_active" | "dependency_kind_not_allowed" | "dependency_cycle"; ref: string }
  | { code: "revision_target_inactive"; ref: string };

export interface AcceptCandidateResult {
  candidateId: string;
  itemId: string;
  shortId: string;
  version: number;
  /** True when the candidate revised an existing item (new version) rather than creating one. */
  revised: boolean;
  edited: boolean;
  /** Upstream item ids added by this accept. */
  dependsOn: string[];
  notes: AcceptNote[];
}

const REVISION_REASON = "new_information" as const;

type CandidateRow = typeof candidate.$inferSelect;

async function lockPendingCandidate(tx: Tx, candidateId: string, engagementId: string | undefined): Promise<CandidateRow> {
  if (!UUID_PATTERN.test(candidateId)) throw new ReviewError("candidate_not_found");
  const [row] = await tx.select().from(candidate).where(eq(candidate.id, candidateId)).for("update");
  if (!row || (engagementId !== undefined && row.engagementId !== engagementId)) throw new ReviewError("candidate_not_found");
  if (row.status !== "pending") throw new ReviewError("candidate_decided");
  return row;
}

function normalizedRefs(refs: readonly string[]): string[] {
  return [...new Set(refs.map((r) => r.trim()).filter((r) => r !== ""))].sort();
}

interface ResolvedDependencies {
  itemIds: string[];
  notes: AcceptNote[];
}

/**
 * Resolves dependency references for an item of `kind`: `#n` → the item an accepted same-run
 * candidate produced; short id or item id → that item. Unresolvable, inactive or rule-breaking
 * references are dropped and returned as notes.
 */
function resolveDependencies(
  state: EngagementState,
  refs: readonly string[],
  kind: Kind,
  siblings: readonly Pick<CandidateRow, "ordinal" | "status" | "resultingItemId">[],
  revising: ItemState | undefined,
): ResolvedDependencies {
  const notes: AcceptNote[] = [];
  const itemIds: string[] = [];
  const clean = normalizedRefs(refs);
  if (clean.length > 0 && !canDependOn(kind)) {
    return { itemIds, notes: clean.map((ref) => ({ code: "dependency_kind_not_allowed" as const, ref })) };
  }
  const byShortId = new Map([...state.items.values()].map((i) => [i.shortId, i]));
  for (const ref of clean) {
    let target: ItemState | undefined;
    const ordinal = /^#(\d+)$/.exec(ref);
    if (ordinal) {
      const sibling = siblings.find((s) => s.ordinal === Number(ordinal[1]));
      if (sibling?.status === "accepted" && sibling.resultingItemId) target = state.items.get(sibling.resultingItemId);
    } else {
      target = UUID_PATTERN.test(ref) ? state.items.get(ref) : byShortId.get(ref);
    }
    if (!target) notes.push({ code: "dependency_unresolved", ref });
    else if (target.lifecycle !== "active") notes.push({ code: "dependency_not_active", ref });
    else if (revising && (target.id === revising.id || wouldCreateCycle(state, revising.id, target.id))) notes.push({ code: "dependency_cycle", ref });
    else if (!itemIds.includes(target.id) && !revising?.dependsOn.has(target.id)) itemIds.push(target.id);
  }
  return { itemIds, notes };
}

/**
 * Accepts a pending candidate: creates the item (or a new version of the item it revises, with
 * the old version's spans replaced by the candidate's verified span), adds the resolved
 * dependencies and marks the candidate accepted with `resulting_item_id` — all in one transaction.
 */
export async function acceptCandidate(ctx: CommandContext, input: AcceptCandidateInput): Promise<AcceptCandidateResult> {
  const edits = input.edits ?? {};
  if (edits.kind !== undefined && !(KINDS as readonly string[]).includes(edits.kind)) {
    throw new DomainError("invalid_event", { type: "item_created", issues: ["payload.kind: invalid kind"] });
  }
  return runInTenant(ctx, async (tx) => {
    const cand = await lockPendingCandidate(tx, input.candidateId, input.engagementId);
    const { state } = await lockAndLoad(tx, cand.engagementId);
    const [run] = await tx
      .select({ model: extractionRun.model, promptVersion: extractionRun.promptVersion })
      .from(extractionRun)
      .where(eq(extractionRun.id, cand.extractionRunId));
    const siblings = await tx
      .select({ ordinal: candidate.ordinal, status: candidate.status, resultingItemId: candidate.resultingItemId })
      .from(candidate)
      .where(eq(candidate.extractionRunId, cand.extractionRunId));

    const notes: AcceptNote[] = [];
    const target = cand.revisesItemId ? state.items.get(cand.revisesItemId) : undefined;
    const revising = target?.lifecycle === "active" ? target : undefined;
    if (cand.revisesItemId && !revising) notes.push({ code: "revision_target_inactive", ref: target?.shortId ?? cand.revisesItemId });

    const kind = edits.kind ?? cand.kind;
    if (revising && kind !== revising.kind) throw new ReviewError("revision_kind_immutable");
    const statement = edits.statement !== undefined ? edits.statement.trim() : cand.statement;
    const suggested = cand.suggestedDependsOn as string[];
    const refs = edits.dependsOn ?? suggested;
    const deps = resolveDependencies(state, refs, kind, siblings, revising);
    notes.push(...deps.notes);
    const edited =
      statement !== cand.statement ||
      kind !== cand.kind ||
      (edits.dependsOn !== undefined && normalizedRefs(edits.dependsOn).join("\n") !== normalizedRefs(suggested).join("\n"));
    const provenance: Provenance = {
      via: "ai_candidate",
      candidate_id: cand.id,
      ...(run ? { model: run.model, prompt_version: run.promptVersion } : {}),
      edited,
    };
    const span = { sourceId: cand.sourceId, start: cand.start, end: cand.end, quote: cand.quote };
    const inTx: CommandContext = { tx, orgId: ctx.orgId, userId: ctx.userId, clock: ctx.clock };

    let result: { itemId: string; shortId: string; version: number };
    if (revising) {
      const current = currentVersionOf(revising);
      result = await reviseItem(inTx, {
        engagementId: cand.engagementId,
        itemId: revising.id,
        statement,
        reasonCode: REVISION_REASON,
        removeSpans: current.spans.map((s) => ({ sourceId: s.source_id, start: s.start, end: s.end })),
        addSpans: [span],
        provenance,
      });
      for (const upstream of deps.itemIds) {
        await addDependency(inTx, { engagementId: cand.engagementId, itemId: revising.id, dependsOnItemId: upstream });
      }
    } else {
      result = await createItem(inTx, {
        engagementId: cand.engagementId,
        kind,
        statement,
        spans: [span],
        dependsOn: deps.itemIds,
        provenance,
      });
    }

    await tx
      .update(candidate)
      .set({ status: "accepted", decidedBy: ctx.userId, decidedAt: ctx.clock(), resultingItemId: result.itemId })
      .where(eq(candidate.id, cand.id));
    return {
      candidateId: cand.id,
      itemId: result.itemId,
      shortId: result.shortId,
      version: result.version,
      revised: revising !== undefined,
      edited,
      dependsOn: deps.itemIds,
      notes,
    };
  });
}

/** Rejects a pending candidate (it stays in the table as `rejected`; nothing enters the ledger). */
export async function rejectCandidate(ctx: CommandContext, input: { candidateId: string; engagementId?: string }): Promise<void> {
  await runInTenant(ctx, async (tx) => {
    const cand = await lockPendingCandidate(tx, input.candidateId, input.engagementId);
    await tx
      .update(candidate)
      .set({ status: "rejected", decidedBy: ctx.userId, decidedAt: ctx.clock() })
      .where(and(eq(candidate.id, cand.id), eq(candidate.status, "pending")));
  });
}
