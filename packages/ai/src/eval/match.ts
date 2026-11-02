export interface Span {
  kind: string;
  start: number;
  end: number;
}

export interface MatchResult {
  /** [predictedIndex, expectedIndex] pairs, one-to-one. */
  pairs: [number, number][];
  unmatchedPredicted: number[];
  unmatchedExpected: number[];
}

export function overlap(a: Pick<Span, "start" | "end">, b: Pick<Span, "start" | "end">): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/**
 * A prediction matches an expected item when it has the same kind and its span overlaps the
 * expected span in the normalized text. Matching is one-to-one and greedy: all eligible pairs
 * are taken in order of decreasing overlap (ties: lower predicted index, then lower expected
 * index), skipping pairs whose prediction or expected item is already used.
 */
export function matchSpans(predicted: readonly Span[], expected: readonly Span[]): MatchResult {
  const eligible: { p: number; e: number; size: number }[] = [];
  predicted.forEach((p, pi) => {
    expected.forEach((e, ei) => {
      const size = p.kind === e.kind ? overlap(p, e) : 0;
      if (size > 0) eligible.push({ p: pi, e: ei, size });
    });
  });
  eligible.sort((a, b) => b.size - a.size || a.p - b.p || a.e - b.e);

  const usedP = new Set<number>();
  const usedE = new Set<number>();
  const pairs: [number, number][] = [];
  for (const { p, e } of eligible) {
    if (usedP.has(p) || usedE.has(e)) continue;
    usedP.add(p);
    usedE.add(e);
    pairs.push([p, e]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return {
    pairs,
    unmatchedPredicted: predicted.map((_, i) => i).filter((i) => !usedP.has(i)),
    unmatchedExpected: expected.map((_, i) => i).filter((i) => !usedE.has(i)),
  };
}
