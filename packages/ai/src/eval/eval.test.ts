import path from "node:path";
import { describe, expect, it } from "vitest";
import { AnthropicModelClient } from "../anthropic-client";
import { loadEvalFixtures, recordedClientFromFixtures, runEval, type EvalReport } from "./run";

// Extraction eval (D-014). Always runs on the recorded model output in fixtures/eval; with
// EVAL_LIVE=1 and ANTHROPIC_API_KEY set it also runs against the real model and prints the
// report (live quality is printed, not gated).
//   pnpm --filter @veradact/ai eval
//   EVAL_LIVE=1 ANTHROPIC_API_KEY=... pnpm --filter @veradact/ai eval

const FIXTURES = path.resolve(import.meta.dirname, "../../../../fixtures/eval");
const LIVE = process.env.EVAL_LIVE === "1" && !!process.env.ANTHROPIC_API_KEY;

function expectShape(report: EvalReport, sources: number): void {
  expect(report.sources).toHaveLength(sources);
  for (const s of [...report.sources, report.overall]) {
    for (const k of ["precision", "recall", "f1"] as const) {
      expect(s[k]).toBeGreaterThanOrEqual(0);
      expect(s[k]).toBeLessThanOrEqual(1);
    }
    expect(s.tp + s.fp).toBe(s.accepted);
    expect(s.tp + s.fn).toBe(s.expected);
    expect(s.accepted + s.dropped).toBe(s.proposed);
  }
}

describe("extraction eval (recorded responses)", () => {
  it("scores the recorded model output with the production verifier and matcher", async () => {
    const client = await recordedClientFromFixtures(FIXTURES);
    const { report, table } = await runEval({ client, fixturesDir: FIXTURES });
    console.log(`\n${table}\n`);
    expectShape(report, 4);

    // Expected numbers, derived from the `_notes` in fixtures/eval/*.recorded.json.
    // A candidate counts as a true positive when it survives quote verification and matches an
    // expected item of the same kind with an overlapping span (one-to-one).
    //
    // e1-retail-kickoff.vtt  8 expected, 8 candidates
    //   candidates[2] WRONG_OFFSETS      quote exact, offsets wrong → offset_corrected, still a TP
    //   candidates[7] HALLUCINATED_QUOTE not in the source → dropped (never reaches scoring)
    //   expected[7]   MISSED             → FN
    //   accepted 7 = TP 7, FP 0; FN 1      → P 7/7 = 1.000, R 7/8 = 0.875
    // e2-insurer-notes.md    8 expected, 8 candidates
    //   candidates[2] WRONG_OFFSETS      → offset_corrected, TP
    //   candidates[7] FALSE_POSITIVE     real quote ("parked, not a commitment") → FP
    //   expected[7]   MISSED             → FN
    //   accepted 8 = TP 7, FP 1; FN 1      → P 7/8 = 0.875, R 7/8 = 0.875
    // e3-hospital-scope.srt  6 expected, 7 candidates
    //   candidates[5] FALSE_POSITIVE     real quote ("nobody has signed up for that") → FP
    //   candidates[6] HALLUCINATED_QUOTE → dropped
    //   expected[5]   MISSED             → FN
    //   accepted 6 = TP 5, FP 1; FN 1      → P 5/6 = 0.833, R 5/6 = 0.833
    // e4-bank-email.txt      6 expected, 6 candidates
    //   candidates[5] KIND_MISMATCH      right span, labelled constraint instead of requirement:
    //                                    same-kind matching fails → it is an FP AND the expected
    //                                    requirement is an FN
    //   accepted 6 = TP 5, FP 1; FN 1      → P 5/6 = 0.833, R 5/6 = 0.833
    // overall (micro): TP 24, FP 3, FN 4; proposed 29, dropped 2 (both hallucinations),
    //   corrected 2 (both wrong offsets), accepted 27, expected 28
    //   → P 24/27 = 0.889, R 24/28 = 0.857, F1 = 2·24/(27+28) = 48/55 = 0.873
    const bySource = Object.fromEntries(report.sources.map((s) => [s.source, s]));
    expect(bySource["e1-retail-kickoff.vtt"]).toMatchObject({ proposed: 8, accepted: 7, corrected: 1, dropped: 1, tp: 7, fp: 0, fn: 1, falsePositives: [], misses: [7] });
    expect(bySource["e2-insurer-notes.md"]).toMatchObject({ proposed: 8, accepted: 8, corrected: 1, dropped: 0, tp: 7, fp: 1, fn: 1, falsePositives: [7], misses: [7] });
    expect(bySource["e3-hospital-scope.srt"]).toMatchObject({ proposed: 7, accepted: 6, corrected: 0, dropped: 1, tp: 5, fp: 1, fn: 1, falsePositives: [5], misses: [5] });
    expect(bySource["e4-bank-email.txt"]).toMatchObject({ proposed: 6, accepted: 6, corrected: 0, dropped: 0, tp: 5, fp: 1, fn: 1, falsePositives: [5], misses: [5] });
    expect(bySource["e1-retail-kickoff.vtt"]?.dropReasons).toEqual({ quote_not_found: 1 });
    expect(bySource["e3-hospital-scope.srt"]?.dropReasons).toEqual({ quote_not_found: 1 });

    expect(bySource["e1-retail-kickoff.vtt"]?.precision).toBe(1);
    expect(bySource["e1-retail-kickoff.vtt"]?.recall).toBe(7 / 8);
    expect(bySource["e2-insurer-notes.md"]?.precision).toBe(7 / 8);
    expect(bySource["e2-insurer-notes.md"]?.recall).toBe(7 / 8);
    for (const s of ["e3-hospital-scope.srt", "e4-bank-email.txt"]) {
      expect(bySource[s]?.precision).toBe(5 / 6);
      expect(bySource[s]?.recall).toBe(5 / 6);
    }

    expect(report.overall).toMatchObject({ expected: 28, proposed: 29, accepted: 27, corrected: 2, dropped: 2, tp: 24, fp: 3, fn: 4 });
    expect(report.overall.precision).toBe(24 / 27);
    expect(report.overall.recall).toBe(24 / 28);
    expect(report.overall.f1).toBeCloseTo(48 / 55, 12);
    expect(table).toMatch(/overall \(micro\)\s+28\s+29\s+27\s+2\s+2\s+24\s+3\s+4\s+0\.889\s+0\.857\s+0\.873/);
  });

  it("locates every expected quote in the parsed text and infers source types", async () => {
    const fixtures = await loadEvalFixtures(FIXTURES);
    expect(fixtures.map((f) => [f.source, f.sourceType])).toEqual([
      ["e1-retail-kickoff.vtt", "machine_transcript"],
      ["e2-insurer-notes.md", "human_notes"],
      ["e3-hospital-scope.srt", "machine_transcript"],
      ["e4-bank-email.txt", "email"],
    ]);
    for (const f of fixtures) {
      for (const e of f.expected) expect(f.parsed.text.slice(e.start, e.end)).toBe(e.quote);
    }
  });
});

describe.runIf(LIVE)("extraction eval (live model)", () => {
  it("runs against AnthropicModelClient and prints the report", { timeout: 15 * 60_000 }, async () => {
    const client = new AnthropicModelClient();
    const { report, table } = await runEval({ client, fixturesDir: FIXTURES });
    console.log(`\n${table}\n`);
    expect(report.client).toBe(client.model);
    expectShape(report, 4);
  });
});
