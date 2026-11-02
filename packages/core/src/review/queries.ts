// Review queue reads (ARCHITECTURE §9.4, §13): candidates grouped by source, with the item a
// revision targets and the suggested dependencies resolved for display.
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { candidate, extractionRun, item, itemVersion, source, sourceContent, type CandidateStatus, type ExtractionRunStatus, type Tx } from "@veradact/db";
import { UUID_PATTERN, type ItemLifecycle, type ItemStatus, type Kind, type SourceType } from "../domain";

export interface CandidateItemRef {
  itemId: string;
  shortId: string;
  kind: Kind;
  status: ItemStatus;
  lifecycle: ItemLifecycle;
  currentVersion: number;
  /** Current statement (for the revision diff). */
  statement: string;
}

export type SuggestedDependencyTarget =
  | { type: "candidate"; candidateId: string; ordinal: number; kind: Kind; statement: string; status: CandidateStatus; resultingItemId: string | null }
  | ({ type: "item" } & CandidateItemRef);

export interface CandidateView {
  id: string;
  extractionRunId: string;
  sourceId: string;
  ordinal: number;
  kind: Kind;
  statement: string;
  quote: string;
  start: number;
  end: number;
  speakerLabel: string | null;
  confidence: number | null;
  verification: "exact" | "offset_corrected";
  status: CandidateStatus;
  decidedAt: Date | null;
  resultingItemId: string | null;
  /** The item this candidate proposes to revise (null for a new item). */
  revises: CandidateItemRef | null;
  /** Each suggestion with what it points at now (null when it points at nothing). */
  suggestedDependencies: { ref: string; target: SuggestedDependencyTarget | null }[];
  createdAt: Date;
}

export interface CandidateGroup {
  sourceId: string;
  title: string | null;
  sourceType: SourceType | null;
  occurredAt: Date | null;
  redacted: boolean;
  candidates: CandidateView[];
}

async function itemRefs(tx: Tx, engagementId: string): Promise<{ byId: Map<string, CandidateItemRef>; byShortId: Map<string, CandidateItemRef> }> {
  const rows = await tx
    .select({
      itemId: item.id,
      shortId: item.shortId,
      kind: item.kind,
      status: item.status,
      lifecycle: item.lifecycle,
      currentVersion: item.currentVersion,
      statement: itemVersion.statement,
    })
    .from(item)
    .innerJoin(itemVersion, and(eq(itemVersion.itemId, item.id), eq(itemVersion.version, item.currentVersion)))
    .where(eq(item.engagementId, engagementId));
  return { byId: new Map(rows.map((r) => [r.itemId, r])), byShortId: new Map(rows.map((r) => [r.shortId, r])) };
}

/**
 * The engagement's candidates with `status` (default `pending`), grouped by source (oldest source
 * first), each group in extraction order.
 */
export async function listCandidates(tx: Tx, engagementId: string, options: { status?: CandidateStatus } = {}): Promise<CandidateGroup[]> {
  const status = options.status ?? "pending";
  const rows = await tx
    .select()
    .from(candidate)
    .where(and(eq(candidate.engagementId, engagementId), eq(candidate.status, status)))
    .orderBy(asc(candidate.createdAt), asc(candidate.extractionRunId), asc(candidate.ordinal));
  if (rows.length === 0) return [];

  const runIds = [...new Set(rows.map((r) => r.extractionRunId))];
  const sourceIds = [...new Set(rows.map((r) => r.sourceId))];
  const [refs, siblings, sources] = await Promise.all([
    itemRefs(tx, engagementId),
    tx
      .select({ id: candidate.id, runId: candidate.extractionRunId, ordinal: candidate.ordinal, kind: candidate.kind, statement: candidate.statement, status: candidate.status, resultingItemId: candidate.resultingItemId })
      .from(candidate)
      .where(inArray(candidate.extractionRunId, runIds)),
    tx
      .select({ id: source.id, sourceType: source.sourceType, occurredAt: source.occurredAt, recordedAt: source.recordedAt, redactedAt: source.redactedAt, title: sourceContent.title })
      .from(source)
      .leftJoin(sourceContent, eq(sourceContent.sourceId, source.id))
      .where(inArray(source.id, sourceIds)),
  ]);

  const target = (runId: string, ref: string): SuggestedDependencyTarget | null => {
    const ordinal = /^#(\d+)$/.exec(ref);
    if (ordinal) {
      const s = siblings.find((c) => c.runId === runId && c.ordinal === Number(ordinal[1]));
      return s ? { type: "candidate", candidateId: s.id, ordinal: s.ordinal, kind: s.kind, statement: s.statement, status: s.status, resultingItemId: s.resultingItemId } : null;
    }
    const found = UUID_PATTERN.test(ref) ? refs.byId.get(ref) : refs.byShortId.get(ref);
    return found ? { type: "item", ...found } : null;
  };

  const views: CandidateView[] = rows.map((r) => ({
    id: r.id,
    extractionRunId: r.extractionRunId,
    sourceId: r.sourceId,
    ordinal: r.ordinal,
    kind: r.kind,
    statement: r.statement,
    quote: r.quote,
    start: r.start,
    end: r.end,
    speakerLabel: r.speakerLabel,
    confidence: r.confidence,
    verification: r.verification,
    status: r.status,
    decidedAt: r.decidedAt,
    resultingItemId: r.resultingItemId,
    revises: r.revisesItemId ? (refs.byId.get(r.revisesItemId) ?? null) : null,
    suggestedDependencies: (r.suggestedDependsOn as string[]).map((ref) => ({ ref, target: target(r.extractionRunId, ref) })),
    createdAt: r.createdAt,
  }));

  const sortedSources = [...sources].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime() || a.id.localeCompare(b.id));
  return sortedSources.map((s) => ({
    sourceId: s.id,
    title: s.title,
    sourceType: s.sourceType,
    occurredAt: s.occurredAt,
    redacted: s.redactedAt !== null,
    candidates: views.filter((v) => v.sourceId === s.id),
  }));
}

export interface ExtractionRunRow {
  id: string;
  sourceId: string;
  model: string;
  promptVersion: string;
  status: ExtractionRunStatus;
  proposedCount: number;
  droppedCount: number;
  correctedCount: number;
  errorCode: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

/** Extraction runs of the engagement (or one source), newest first. */
export async function listExtractionRuns(tx: Tx, engagementId: string, options: { sourceId?: string } = {}): Promise<ExtractionRunRow[]> {
  const conditions = [eq(extractionRun.engagementId, engagementId)];
  if (options.sourceId) conditions.push(eq(extractionRun.sourceId, options.sourceId));
  const rows = await tx
    .select()
    .from(extractionRun)
    .where(and(...conditions))
    .orderBy(desc(extractionRun.createdAt), desc(extractionRun.id));
  return rows.map(({ orgId: _orgId, engagementId: _engagementId, ...r }) => r);
}
