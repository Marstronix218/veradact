import { describe, expect, it } from "vitest";
import type { RawCandidate } from "./model-client";
import { MAX_QUOTE_CHARS, verifyCandidates, verifyQuote } from "./verify";

const TEXT = [
  "Dana Whitcombe: The first trucks now roll out at 5:30, not six.",
  "Lena Sorensen: Route suggestions need to be ready by 5:00 a.m.",
  "Marcus Oyelaran: Only Halvorsen IT can approve new integrations.",
  "Lena Sorensen: Route suggestions need to be ready by 5:00 a.m.",
].join("\n");

const at = (quote: string, from = 0) => {
  const start = TEXT.indexOf(quote, from);
  return { quote, start, end: start + quote.length };
};

function cand(over: Partial<RawCandidate>): RawCandidate {
  return {
    kind: "requirement",
    statement: "Route suggestions are ready by 5:00 a.m.",
    quote: "Route suggestions need to be ready by 5:00 a.m.",
    start: 0,
    end: 0,
    speaker_label: "Lena Sorensen",
    confidence: 0.9,
    suggested_depends_on: [],
    revises: null,
    ...over,
  };
}

describe("verifyQuote", () => {
  it("exact at the stated offsets → exact", () => {
    const q = at("Only Halvorsen IT can approve new integrations");
    expect(verifyQuote(TEXT, q)).toEqual({ ok: true, verification: "exact", start: q.start, end: q.end });
  });

  it("exact quote with wrong offsets → offset_corrected to the real span", () => {
    const q = at("The first trucks now roll out at 5:30");
    expect(verifyQuote(TEXT, { quote: q.quote, start: q.start + 40, end: q.end + 40 })).toEqual({
      ok: true,
      verification: "offset_corrected",
      start: q.start,
      end: q.end,
    });
    // end inconsistent with start + length is not "exact" either
    expect(verifyQuote(TEXT, { quote: q.quote, start: q.start, end: q.end + 3 })).toMatchObject({
      verification: "offset_corrected",
      start: q.start,
    });
  });

  it("negative or out-of-range offsets are corrected, not trusted", () => {
    const q = at("The first trucks");
    expect(verifyQuote(TEXT, { quote: q.quote, start: -5, end: 11 })).toMatchObject({ verification: "offset_corrected", start: q.start });
    expect(verifyQuote(TEXT, { quote: q.quote, start: 10_000, end: 10_016 })).toMatchObject({ verification: "offset_corrected" });
  });

  it("duplicate quote → the occurrence nearest to the stated start", () => {
    const quote = "Route suggestions need to be ready by 5:00 a.m.";
    const first = TEXT.indexOf(quote);
    const second = TEXT.indexOf(quote, first + 1);
    expect(second).toBeGreaterThan(first);
    expect(verifyQuote(TEXT, { quote, start: second - 30, end: second - 30 + quote.length })).toEqual({
      ok: true,
      verification: "offset_corrected",
      start: second,
      end: second + quote.length,
    });
    expect(verifyQuote(TEXT, { quote, start: first + 10, end: first + 10 + quote.length })).toMatchObject({ start: first });
    // exact at the second occurrence stays exact
    expect(verifyQuote(TEXT, { quote, start: second, end: second + quote.length })).toMatchObject({ verification: "exact", start: second });
    // equidistant → earlier
    const mid = (first + second) / 2;
    expect(verifyQuote(TEXT, { quote, start: mid, end: mid + quote.length })).toMatchObject({ start: first });
  });

  it("hallucinated (paraphrased) quote → dropped", () => {
    expect(verifyQuote(TEXT, { quote: "Route suggestions must be ready by 5 a.m.", start: 70, end: 110 })).toEqual({
      ok: false,
      reason: "quote_not_found",
    });
    // near-miss whitespace/case is not "close enough"
    expect(verifyQuote(TEXT, { quote: "only halvorsen IT can approve", start: 0, end: 29 })).toMatchObject({ ok: false });
  });

  it("empty, whitespace-only and over-long quotes → dropped", () => {
    expect(verifyQuote(TEXT, { quote: "", start: 0, end: 0 })).toEqual({ ok: false, reason: "empty_quote" });
    expect(verifyQuote(TEXT, { quote: " \n\t", start: 0, end: 3 })).toEqual({ ok: false, reason: "empty_quote" });
    const long = "x".repeat(MAX_QUOTE_CHARS + 1);
    expect(verifyQuote(long, { quote: long, start: 0, end: long.length })).toEqual({ ok: false, reason: "quote_too_long" });
    const max = "x".repeat(MAX_QUOTE_CHARS);
    expect(verifyQuote(max, { quote: max, start: 0, end: max.length })).toMatchObject({ ok: true, verification: "exact" });
  });
});

describe("verifyCandidates", () => {
  it("accepts, corrects and drops, keeping original indices and ordinals", () => {
    const exact = at("Only Halvorsen IT can approve new integrations");
    const moved = at("The first trucks now roll out at 5:30");
    const raw: RawCandidate[] = [
      cand({ kind: "constraint", ...exact, statement: "  Only Halvorsen IT approves integrations.  " }),
      cand({ quote: "this was never said", start: 3, end: 22 }),
      cand({ kind: "decision", ...moved, start: 0, end: moved.quote.length, suggested_depends_on: ["#1"], confidence: 1.4 }),
      cand({ kind: "wish", ...exact }),
      cand({ statement: "   ", ...exact }),
      cand({ quote: "   ", start: 0, end: 3 }),
    ];
    const result = verifyCandidates(TEXT, raw);

    expect(result.accepted.map((c) => [c.index, c.ordinal, c.verification, c.start, c.end])).toEqual([
      [0, 1, "exact", exact.start, exact.end],
      [2, 3, "offset_corrected", moved.start, moved.end],
    ]);
    expect(result.accepted[0]?.statement).toBe("Only Halvorsen IT approves integrations.");
    expect(result.accepted[1]?.confidence).toBe(1);
    expect(result.accepted[1]?.suggested_depends_on).toEqual(["#1"]);
    expect(result.dropped).toEqual([
      { index: 1, reason: "quote_not_found" },
      { index: 3, reason: "unknown_kind" },
      { index: 4, reason: "empty_statement" },
      { index: 5, reason: "empty_quote" },
    ]);
    expect(result.counts).toEqual({ proposed: 6, accepted: 2, exact: 1, corrected: 1, dropped: 4 });
    for (const c of result.accepted) expect(TEXT.slice(c.start, c.end)).toBe(c.quote);
  });

  it("does not mutate its input", () => {
    const raw = [cand({ ...at("The first trucks"), start: 5, end: 21 })];
    const copy = structuredClone(raw);
    verifyCandidates(TEXT, raw);
    expect(raw).toEqual(copy);
  });
});
