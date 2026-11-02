import { describe, expect, it } from "vitest";
import { matchSpans, overlap } from "./match";
import { microAverage, score } from "./score";

describe("matchSpans", () => {
  it("needs the same kind and a non-empty overlap", () => {
    const r = matchSpans(
      [
        { kind: "decision", start: 0, end: 10 },
        { kind: "constraint", start: 20, end: 30 },
        { kind: "requirement", start: 40, end: 50 },
      ],
      [
        { kind: "decision", start: 5, end: 15 },
        { kind: "requirement", start: 20, end: 30 },
        { kind: "requirement", start: 50, end: 60 }, // touching, not overlapping
      ],
    );
    expect(r.pairs).toEqual([[0, 0]]);
    expect(r.unmatchedPredicted).toEqual([1, 2]);
    expect(r.unmatchedExpected).toEqual([1, 2]);
  });

  it("is one-to-one and prefers the larger overlap", () => {
    const r = matchSpans(
      [
        { kind: "decision", start: 0, end: 12 }, // overlaps e0 by 2, e1 by 10
        { kind: "decision", start: 8, end: 12 }, // overlaps e1 by 4 only
      ],
      [
        { kind: "decision", start: 0, end: 2 },
        { kind: "decision", start: 2, end: 20 },
      ],
    );
    expect(r.pairs).toEqual([
      [0, 1],
    ]);
    expect(r.unmatchedPredicted).toEqual([1]);
    expect(r.unmatchedExpected).toEqual([0]);
  });

  it("two predictions of the same expected item: one TP, one FP", () => {
    const r = matchSpans(
      [
        { kind: "problem", start: 0, end: 10 },
        { kind: "problem", start: 0, end: 10 },
      ],
      [{ kind: "problem", start: 0, end: 10 }],
    );
    expect(r.pairs).toEqual([[0, 0]]);
    expect(r.unmatchedPredicted).toEqual([1]);
  });

  it("overlap()", () => {
    expect(overlap({ start: 0, end: 5 }, { start: 5, end: 9 })).toBe(0);
    expect(overlap({ start: 0, end: 6 }, { start: 5, end: 9 })).toBe(1);
  });
});

describe("score", () => {
  it("computes precision, recall and F1 with vacuous denominators", () => {
    expect(score(3, 1, 2)).toEqual({ tp: 3, fp: 1, fn: 2, precision: 0.75, recall: 0.6, f1: (2 * 0.75 * 0.6) / 1.35 });
    expect(score(0, 0, 0)).toMatchObject({ precision: 1, recall: 1, f1: 1 });
    expect(score(0, 0, 4)).toMatchObject({ precision: 1, recall: 0 });
    expect(score(0, 2, 0)).toMatchObject({ precision: 0, recall: 1 });
    expect(score(0, 2, 3).f1).toBe(0);
  });

  it("micro-averages by summing counts", () => {
    expect(microAverage([score(1, 0, 1), score(3, 1, 0)])).toMatchObject({ tp: 4, fp: 1, fn: 1, precision: 0.8, recall: 0.8 });
  });
});
