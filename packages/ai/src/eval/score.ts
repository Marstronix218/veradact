export interface Score {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

/**
 * Precision = tp / (tp + fp), recall = tp / (tp + fn), F1 = harmonic mean. An empty
 * denominator scores 1 (nothing predicted → no false positives; nothing expected → nothing
 * missed); F1 is 0 when precision + recall is 0.
 */
export function score(tp: number, fp: number, fn: number): Score {
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, precision, recall, f1 };
}

/** Micro-average: sum the counts, then score. */
export function microAverage(scores: readonly Pick<Score, "tp" | "fp" | "fn">[]): Score {
  const sum = (k: "tp" | "fp" | "fn") => scores.reduce((n, s) => n + s[k], 0);
  return score(sum("tp"), sum("fp"), sum("fn"));
}
