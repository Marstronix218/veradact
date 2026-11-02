import fs from "node:fs";
import path from "node:path";
import { detectFormat, parseSource, type FileFormat, type ParsedSource } from "@veradact/ingest";
import { z } from "zod";
import { ITEM_KINDS, type ModelClient, type SourceType } from "../model-client";
import { RecordedModelClient, RecordedResponseSchema, type RecordedResponse } from "../recorded-client";
import { verifyCandidates, type DropReason } from "../verify";
import { matchSpans } from "./match";
import { microAverage, score, type Score } from "./score";

// Extraction eval (ARCHITECTURE §9.3, D-014): parse each fixtures/eval source with
// @veradact/ingest, run the model client, verify quotes with the production verifier, match
// accepted candidates to expected items (same kind + overlapping span) and score.

const ExpectedFileSchema = z.object({
  source: z.string(),
  expected: z.array(z.object({ kind: z.enum(ITEM_KINDS), quote: z.string(), statement: z.string() })),
});

export interface ExpectedItem {
  kind: (typeof ITEM_KINDS)[number];
  quote: string;
  statement: string;
  /** Located in the parsed text (fixtures carry quotes, not offsets). */
  start: number;
  end: number;
}

export interface EvalFixture {
  /** Source filename, e.g. "e1-retail-kickoff.vtt". */
  source: string;
  format: FileFormat;
  sourceType: SourceType;
  parsed: ParsedSource;
  expected: ExpectedItem[];
  /** `<base>.recorded.json`, when present. */
  recorded: RecordedResponse | null;
}

export interface EvalSourceReport extends Score {
  source: string;
  sourceType: SourceType;
  expected: number;
  proposed: number;
  accepted: number;
  corrected: number;
  dropped: number;
  dropReasons: Partial<Record<DropReason, number>>;
  /** Raw candidate indices of accepted candidates that matched no expected item. */
  falsePositives: number[];
  /** Indices into the expected list that no accepted candidate matched. */
  misses: number[];
}

export interface EvalReport {
  client: string;
  promptVersion: string;
  sources: EvalSourceReport[];
  overall: Score & { expected: number; proposed: number; accepted: number; corrected: number; dropped: number };
}

function sourceTypeOf(format: FileFormat, text: string): SourceType {
  if (format === "vtt" || format === "srt") return "machine_transcript";
  if (format === "txt" && /^From: /.test(text)) return "email";
  return "human_notes";
}

function locate(text: string, quote: string, where: string): number {
  const at = text.indexOf(quote);
  if (at === -1 || text.indexOf(quote, at + 1) !== -1) {
    throw new Error(`${where}: expected quote must occur exactly once in the parsed source`);
  }
  return at;
}

/** Load and parse every `<base>.expected.json` (plus its source and optional recording) in `fixturesDir`. */
export async function loadEvalFixtures(fixturesDir: string): Promise<EvalFixture[]> {
  const files = fs
    .readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".expected.json"))
    .sort();
  const fixtures: EvalFixture[] = [];
  for (const file of files) {
    const base = file.slice(0, -".expected.json".length);
    const exp = ExpectedFileSchema.parse(JSON.parse(fs.readFileSync(path.join(fixturesDir, file), "utf8")));
    const bytes = new Uint8Array(fs.readFileSync(path.join(fixturesDir, exp.source)));
    const format = detectFormat(exp.source, bytes);
    const parsed = await parseSource({ format, bytes, filename: exp.source });
    const expected = exp.expected.map((e, i) => {
      const start = locate(parsed.text, e.quote, `${base}.expected[${i}]`);
      return { ...e, start, end: start + e.quote.length };
    });
    const recordedPath = path.join(fixturesDir, `${base}.recorded.json`);
    const recorded = fs.existsSync(recordedPath)
      ? RecordedResponseSchema.parse(JSON.parse(fs.readFileSync(recordedPath, "utf8")))
      : null;
    fixtures.push({ source: exp.source, format, sourceType: sourceTypeOf(format, parsed.text), parsed, expected, recorded });
  }
  return fixtures;
}

/** A RecordedModelClient answering every eval source that has a `.recorded.json`. */
export async function recordedClientFromFixtures(fixturesDir: string): Promise<RecordedModelClient> {
  const fixtures = await loadEvalFixtures(fixturesDir);
  return new RecordedModelClient(
    fixtures.flatMap((f) => (f.recorded ? [{ sourceText: f.parsed.text, candidates: f.recorded.candidates }] : [])),
  );
}

export async function runEval(options: {
  client: ModelClient;
  fixturesDir: string;
  promptVersion?: string;
}): Promise<{ report: EvalReport; table: string }> {
  const promptVersion = options.promptVersion ?? "extract.v1";
  const fixtures = await loadEvalFixtures(options.fixturesDir);
  const sources: EvalSourceReport[] = [];

  for (const f of fixtures) {
    const raw = await options.client.extract({
      sourceText: f.parsed.text,
      sourceType: f.sourceType,
      existingItems: [],
      promptVersion,
    });
    const verified = verifyCandidates(f.parsed.text, raw);
    const match = matchSpans(verified.accepted, f.expected);
    const dropReasons: Partial<Record<DropReason, number>> = {};
    for (const d of verified.dropped) dropReasons[d.reason] = (dropReasons[d.reason] ?? 0) + 1;
    sources.push({
      source: f.source,
      sourceType: f.sourceType,
      expected: f.expected.length,
      proposed: verified.counts.proposed,
      accepted: verified.counts.accepted,
      corrected: verified.counts.corrected,
      dropped: verified.counts.dropped,
      dropReasons,
      falsePositives: match.unmatchedPredicted.map((i) => verified.accepted[i]?.index ?? -1),
      misses: match.unmatchedExpected,
      ...score(match.pairs.length, match.unmatchedPredicted.length, match.unmatchedExpected.length),
    });
  }

  const sum = (k: "expected" | "proposed" | "accepted" | "corrected" | "dropped") => sources.reduce((n, s) => n + s[k], 0);
  const report: EvalReport = {
    client: options.client.name,
    promptVersion,
    sources,
    overall: {
      expected: sum("expected"),
      proposed: sum("proposed"),
      accepted: sum("accepted"),
      corrected: sum("corrected"),
      dropped: sum("dropped"),
      ...microAverage(sources),
    },
  };
  return { report, table: formatEvalTable(report) };
}

/** Fixed-width table of the report (per source + micro-averaged overall). */
export function formatEvalTable(report: EvalReport): string {
  const header = ["source", "expected", "proposed", "accepted", "corrected", "dropped", "tp", "fp", "fn", "precision", "recall", "f1"];
  type Row = Omit<EvalSourceReport, "sourceType" | "dropReasons" | "falsePositives" | "misses">;
  const row = (name: string, r: Row) => [
    name,
    ...[r.expected, r.proposed, r.accepted, r.corrected, r.dropped, r.tp, r.fp, r.fn].map(String),
    ...[r.precision, r.recall, r.f1].map((x) => x.toFixed(3)),
  ];
  const rows = [header, ...report.sources.map((s) => row(s.source, s)), row("overall (micro)", { source: "", ...report.overall })];
  const widths = header.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  const fmt = (r: string[]) => r.map((cell, c) => (c === 0 ? cell.padEnd(widths[c] ?? 0) : cell.padStart(widths[c] ?? 0))).join("  ");
  const rule = widths.map((w) => "-".repeat(w)).join("  ");
  const [head, ...body] = rows;
  const last = body.pop();
  return [
    `Extraction eval - client: ${report.client}, prompt: ${report.promptVersion}`,
    fmt(head ?? []),
    rule,
    ...body.map(fmt),
    rule,
    fmt(last ?? []),
  ].join("\n");
}
