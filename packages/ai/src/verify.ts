import { ITEM_KINDS, type ItemKind, type RawCandidate } from "./model-client";

// Quote verification (ARCHITECTURE §9.3, D-015). Pure. Models copy text well but count
// characters badly, so a quote that is an exact substring elsewhere keeps its candidate with
// corrected offsets; a quote that is not an exact substring anywhere is dropped.

export const MAX_QUOTE_CHARS = 500;

export type Verification = "exact" | "offset_corrected";
export type QuoteDropReason = "empty_quote" | "quote_too_long" | "quote_not_found";
export type DropReason = QuoteDropReason | "unknown_kind" | "empty_statement";

export type QuoteVerification =
  | { ok: true; verification: Verification; start: number; end: number }
  | { ok: false; reason: QuoteDropReason };

/**
 * `text.slice(start, end) === quote` → exact. Otherwise the occurrence of `quote` nearest to the
 * stated `start` (ties → earlier) → offset_corrected. Otherwise dropped.
 */
export function verifyQuote(text: string, candidate: Pick<RawCandidate, "quote" | "start" | "end">): QuoteVerification {
  const { quote, start, end } = candidate;
  if (quote.trim() === "") return { ok: false, reason: "empty_quote" };
  if (quote.length > MAX_QUOTE_CHARS) return { ok: false, reason: "quote_too_long" };
  if (start >= 0 && end === start + quote.length && text.slice(start, end) === quote) {
    return { ok: true, verification: "exact", start, end };
  }
  let best = -1;
  for (let i = text.indexOf(quote); i !== -1; i = text.indexOf(quote, i + 1)) {
    if (best === -1 || Math.abs(i - start) < Math.abs(best - start)) best = i;
  }
  if (best === -1) return { ok: false, reason: "quote_not_found" };
  return { ok: true, verification: "offset_corrected", start: best, end: best + quote.length };
}

export interface VerifiedCandidate extends RawCandidate {
  kind: ItemKind;
  /** 0-based position in the raw list given to verifyCandidates. */
  index: number;
  /** 1-based position (`#ordinal` in suggested_depends_on refers to this); store as candidate.ordinal. */
  ordinal: number;
  verification: Verification;
}

export interface VerificationCounts {
  /** All raw candidates → extraction_run.proposed_count. */
  proposed: number;
  accepted: number;
  exact: number;
  /** → extraction_run.corrected_count */
  corrected: number;
  /** → extraction_run.dropped_count */
  dropped: number;
}

export interface VerificationResult {
  accepted: VerifiedCandidate[];
  dropped: { index: number; reason: DropReason }[];
  counts: VerificationCounts;
}

const KINDS: ReadonlySet<string> = new Set(ITEM_KINDS);
const isKind = (k: string): k is ItemKind => KINDS.has(k);

/**
 * Verify every raw candidate against the normalized source text. Accepted candidates carry final
 * offsets (`start`/`end`), a trimmed statement, confidence clamped to [0, 1] and their original
 * index/ordinal so `#n` dependency references still resolve after drops.
 */
export function verifyCandidates(text: string, raw: readonly RawCandidate[]): VerificationResult {
  const accepted: VerifiedCandidate[] = [];
  const dropped: { index: number; reason: DropReason }[] = [];

  raw.forEach((candidate, index) => {
    const { kind } = candidate;
    if (!isKind(kind)) {
      dropped.push({ index, reason: "unknown_kind" });
      return;
    }
    const statement = candidate.statement.trim();
    if (statement === "") {
      dropped.push({ index, reason: "empty_statement" });
      return;
    }
    const v = verifyQuote(text, candidate);
    if (!v.ok) {
      dropped.push({ index, reason: v.reason });
      return;
    }
    accepted.push({
      ...candidate,
      kind,
      statement,
      confidence: Math.min(1, Math.max(0, candidate.confidence)),
      start: v.start,
      end: v.end,
      verification: v.verification,
      index,
      ordinal: index + 1,
    });
  });

  const corrected = accepted.filter((c) => c.verification === "offset_corrected").length;
  return {
    accepted,
    dropped,
    counts: {
      proposed: raw.length,
      accepted: accepted.length,
      exact: accepted.length - corrected,
      corrected,
      dropped: dropped.length,
    },
  };
}
