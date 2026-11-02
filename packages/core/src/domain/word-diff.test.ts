import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { wordDiff, type WordDiffSegment } from "./word-diff";

const side = (segments: WordDiffSegment[], keep: "insert" | "delete") =>
  segments
    .filter((s) => s.op === "equal" || s.op === keep)
    .map((s) => s.text)
    .join("");

describe("wordDiff", () => {
  it("diffs words", () => {
    expect(wordDiff("Nightly export to S3", "Nightly export to the EU data lake")).toEqual([
      { op: "equal", text: "Nightly export to " },
      { op: "delete", text: "S3" },
      { op: "insert", text: "the EU data lake" },
    ]);
  });

  it("handles insertions and deletions in the middle", () => {
    expect(wordDiff("export data nightly", "export all data nightly")).toEqual([
      { op: "equal", text: "export " },
      { op: "insert", text: "all " },
      { op: "equal", text: "data nightly" },
    ]);
    expect(wordDiff("a b c d", "a d")).toEqual([
      { op: "equal", text: "a " },
      { op: "delete", text: "b c " },
      { op: "equal", text: "d" },
    ]);
  });

  it("handles empty and identical inputs", () => {
    expect(wordDiff("", "")).toEqual([]);
    expect(wordDiff("", "new text")).toEqual([{ op: "insert", text: "new text" }]);
    expect(wordDiff("old", "")).toEqual([{ op: "delete", text: "old" }]);
    expect(wordDiff("same text", "same text")).toEqual([{ op: "equal", text: "same text" }]);
  });

  it("reconstructs both sides and merges adjacent ops (property)", () => {
    const words = fc.array(fc.constantFrom("a", "b", "c", "export", "data", "é", "🚚"), { maxLength: 12 });
    const seps = fc.constantFrom(" ", "  ", "\n", "\t ");
    const text = fc.tuple(words, seps).map(([w, s]) => w.join(s));
    fc.assert(
      fc.property(text, text, (a, b) => {
        const segments = wordDiff(a, b);
        expect(side(segments, "delete")).toBe(a);
        expect(side(segments, "insert")).toBe(b);
        for (let i = 1; i < segments.length; i++) expect(segments[i]!.op).not.toBe(segments[i - 1]!.op);
        for (const s of segments) expect(s.text.length).toBeGreaterThan(0);
      }),
      { numRuns: 300 },
    );
  });

  it("degrades gracefully on very large inputs", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join(" ");
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join(" ");
    const segments = wordDiff(a, b);
    expect(side(segments, "delete")).toBe(a);
    expect(side(segments, "insert")).toBe(b);
  });
});
