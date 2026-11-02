// Span resolution for new item versions (ARCHITECTURE §3, §5.2, §9.4): spans are verified against
// `source_content` at write time — `sha256(text) == source_sha256` and `text.slice(start, end)`
// equals the quote the member or candidate supplied.
import { inArray } from "drizzle-orm";
import { sourceContent, type Tx } from "@veradact/db";
import { sha256Hex, type EngagementState, type Span } from "../domain";
import { DomainError } from "../errors";

/**
 * A quote to cite: either the exact quote alone (the server finds its unique occurrence) or
 * offsets into the normalized source text, optionally with the quote they must match.
 */
export type SpanInput =
  | { sourceId: string; quote: string; start?: undefined; end?: undefined }
  | { sourceId: string; start: number; end: number; quote?: string };

/** Quotes are compared with the source's normalization (NFC, `\n` line endings). */
export function normalizeQuote(quote: string): string {
  return quote.replace(/\r\n?/g, "\n").normalize("NFC");
}

/** Start offsets of every (possibly overlapping) occurrence of `needle`, up to `limit`. */
export function findOccurrences(text: string, needle: string, limit = 2): number[] {
  const found: number[] = [];
  if (needle === "") return found;
  for (let i = text.indexOf(needle); i !== -1 && found.length < limit; i = text.indexOf(needle, i + 1)) found.push(i);
  return found;
}

export function sameSpan(a: Pick<Span, "source_id" | "start" | "end">, b: Pick<Span, "source_id" | "start" | "end">): boolean {
  return a.source_id === b.source_id && a.start === b.start && a.end === b.end;
}

/**
 * Resolves and verifies `inputs` against unredacted sources of the engagement. Returns bare spans
 * (`source_id, source_sha256, start, end`) in input order with exact duplicates removed.
 */
export async function resolveSpans(tx: Tx, state: EngagementState, inputs: readonly SpanInput[]): Promise<Span[]> {
  if (inputs.length === 0) return [];
  const ids = [...new Set(inputs.map((s) => s.sourceId))];
  for (const id of ids) {
    const source = state.sources.get(id);
    if (!source) throw new DomainError("source_not_found", { sourceId: id });
    if (source.redacted) throw new DomainError("source_redacted", { sourceId: id });
  }
  const rows = await tx.select({ sourceId: sourceContent.sourceId, text: sourceContent.text }).from(sourceContent).where(inArray(sourceContent.sourceId, ids));
  const texts = new Map<string, string>();
  for (const id of ids) {
    const row = rows.find((r) => r.sourceId === id);
    const source = state.sources.get(id)!;
    if (!row || sha256Hex(row.text) !== source.contentSha256) throw new DomainError("source_integrity_mismatch", { sourceId: id });
    texts.set(id, row.text);
  }

  const spans: Span[] = [];
  inputs.forEach((input, index) => {
    const text = texts.get(input.sourceId)!;
    const sha = state.sources.get(input.sourceId)!.contentSha256;
    let start: number;
    let end: number;
    if (input.start === undefined) {
      const quote = normalizeQuote(input.quote);
      if (quote.trim() === "") throw new DomainError("quote_not_found", { sourceId: input.sourceId, index });
      const occurrences = findOccurrences(text, quote);
      if (occurrences.length === 0) throw new DomainError("quote_not_found", { sourceId: input.sourceId, index });
      if (occurrences.length > 1) throw new DomainError("quote_ambiguous", { sourceId: input.sourceId, index });
      start = occurrences[0]!;
      end = start + quote.length;
    } else {
      start = input.start;
      end = input.end;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > text.length) {
        throw new DomainError("span_out_of_range", { sourceId: input.sourceId, index });
      }
      if (input.quote !== undefined && normalizeQuote(input.quote) !== text.slice(start, end)) {
        throw new DomainError("quote_mismatch", { sourceId: input.sourceId, index });
      }
    }
    const span: Span = { source_id: input.sourceId, source_sha256: sha, start, end };
    if (!spans.some((s) => sameSpan(s, span))) spans.push(span);
  });
  return spans;
}
