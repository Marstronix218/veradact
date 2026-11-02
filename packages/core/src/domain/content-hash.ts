import { canonicalJson } from "./canonical";
import type { Kind, Manual, Span } from "./events";
import { sha256Hex } from "./hash";

export interface ItemContentFields {
  engagement_id: string;
  item_id: string;
  kind: Kind;
  version: number;
  statement: string;
  spans: readonly Span[];
  manual: Manual | null;
}

/** Copies only the four hashed span fields (drops projection-only fields such as `carried`). */
function bareSpan(s: Span): Span {
  return { source_id: s.source_id, source_sha256: s.source_sha256, start: s.start, end: s.end };
}

/**
 * `content_hash = sha256(canonical({ engagement_id, item_id, kind, version, statement, spans, manual }))`
 * (ARCHITECTURE §3). Dependencies are not part of confirmed content.
 */
export function itemContentHash(fields: ItemContentFields): string {
  return sha256Hex(
    canonicalJson({
      engagement_id: fields.engagement_id,
      item_id: fields.item_id,
      kind: fields.kind,
      version: fields.version,
      statement: fields.statement,
      spans: fields.spans.map(bareSpan),
      manual: fields.manual === null ? null : { entered_by: fields.manual.entered_by },
    }),
  );
}

export class SourcedOrManualError extends Error {
  constructor(problem: "neither" | "both") {
    super(
      problem === "neither"
        ? "item version must cite at least one source span or be marked manual"
        : "item version cannot both cite source spans and be marked manual",
    );
    this.name = "SourcedOrManualError";
  }
}

/** True when `spans.length >= 1` XOR `manual != null` (CLAUDE.md invariant 5). */
export function isSourcedOrManual(spans: readonly unknown[], manual: unknown): boolean {
  return spans.length >= 1 !== (manual !== null && manual !== undefined);
}

/** Throws `SourcedOrManualError` unless `spans.length >= 1` XOR `manual != null`. */
export function assertSourcedOrManual(spans: readonly unknown[], manual: unknown): void {
  if (isSourcedOrManual(spans, manual)) return;
  throw new SourcedOrManualError(spans.length >= 1 ? "both" : "neither");
}
