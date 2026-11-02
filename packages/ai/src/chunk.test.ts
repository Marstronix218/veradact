import { describe, expect, it } from "vitest";
import { chunkText, rebaseCandidates } from "./chunk";
import type { RawCandidate } from "./model-client";

describe("chunkText", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `Speaker ${i % 3}: line number ${i} says something.`);
  const text = lines.join("\n");

  it("returns the whole text as one chunk when it fits", () => {
    expect(chunkText(text, text.length)).toEqual([{ text, offset: 0 }]);
    expect(chunkText("", 10)).toEqual([]);
  });

  it("splits on line boundaries, within the limit, and concatenates back exactly", () => {
    const chunks = chunkText(text, 200);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.map((c) => c.text).join("")).toBe(text);
    let offset = 0;
    for (const [i, c] of chunks.entries()) {
      expect(c.offset).toBe(offset);
      expect(c.text.length).toBeLessThanOrEqual(200);
      if (i < chunks.length - 1) expect(c.text.endsWith("\n")).toBe(true);
      expect(text.slice(c.offset, c.offset + c.text.length)).toBe(c.text);
      offset += c.text.length;
    }
  });

  it("splits an over-long line at a space, then hard-splits without breaking surrogate pairs", () => {
    const words = "alpha beta gamma delta epsilon";
    const spaced = chunkText(words, 12);
    expect(spaced.map((c) => c.text)).toEqual(["alpha beta ", "gamma delta ", "epsilon"]);

    const emoji = "😀".repeat(5); // 10 code units, no spaces
    const hard = chunkText(emoji, 3);
    expect(hard.map((c) => c.text).join("")).toBe(emoji);
    for (const c of hard) expect(/^(?:[\uD800-\uDBFF][\uDC00-\uDFFF])+$/.test(c.text)).toBe(true);
  });

  it("rejects silly limits", () => {
    expect(() => chunkText("abc", 1)).toThrow(RangeError);
    expect(() => chunkText("abc", 2.5)).toThrow(RangeError);
  });
});

describe("rebaseCandidates", () => {
  const c = (over: Partial<RawCandidate>): RawCandidate => ({
    kind: "decision",
    statement: "s",
    quote: "q",
    start: 5,
    end: 6,
    speaker_label: null,
    confidence: 0.5,
    suggested_depends_on: [],
    revises: null,
    ...over,
  });

  it("adds the chunk offset and shifts in-range ordinals; drops out-of-range ordinals", () => {
    const out = rebaseCandidates(
      [c({}), c({ start: 20, end: 30, suggested_depends_on: ["#1", "HALV-A3", "#3", "#0", " #2 "] })],
      1000,
      4,
    );
    expect(out[0]).toMatchObject({ start: 1005, end: 1006 });
    expect(out[1]).toMatchObject({ start: 1020, end: 1030, suggested_depends_on: ["#5", "HALV-A3", "#6"] });
  });
});
