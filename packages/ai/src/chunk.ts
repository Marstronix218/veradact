import type { RawCandidate } from "./model-client";

export interface Chunk {
  text: string;
  /** Offset of `text` within the full source text. */
  offset: number;
}

/**
 * Split normalized source text into chunks of at most `maxChars`, breaking after a newline.
 * Every @veradact/ingest segment (transcript cue, note line) is one line, so chunks end on
 * segment boundaries and a verbatim quote is never cut. A single line longer than `maxChars` is
 * split at its last space (or hard-split, never inside a surrogate pair). The chunks
 * concatenate back to `text` exactly.
 */
export function chunkText(text: string, maxChars: number): Chunk[] {
  if (!Number.isInteger(maxChars) || maxChars < 2) throw new RangeError("maxChars must be an integer >= 2");
  const chunks: Chunk[] = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + maxChars, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end - 1);
      if (newline >= pos) {
        end = newline + 1;
      } else {
        const space = text.lastIndexOf(" ", end - 1);
        if (space > pos) end = space + 1;
        else if (/[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end -= 1;
      }
    }
    chunks.push({ text: text.slice(pos, end), offset: pos });
    pos = end;
  }
  return chunks;
}

const ORDINAL_REF = /^#(\d+)$/;

/**
 * Re-base one chunk's candidates into full-text coordinates: add the chunk offset to start/end
 * and shift `#n` ordinal references by the number of candidates from earlier chunks. Ordinal
 * references outside this chunk's own list cannot resolve and are removed (rather than being
 * shifted onto an unrelated candidate). Short-id references are kept as is.
 */
export function rebaseCandidates(candidates: readonly RawCandidate[], offset: number, ordinalBase: number): RawCandidate[] {
  return candidates.map((c) => ({
    ...c,
    start: c.start + offset,
    end: c.end + offset,
    suggested_depends_on: c.suggested_depends_on.flatMap((ref) => {
      const m = ORDINAL_REF.exec(ref.trim());
      if (!m) return [ref];
      const n = Number(m[1]);
      return n >= 1 && n <= candidates.length ? [`#${n + ordinalBase}`] : [];
    }),
  }));
}
