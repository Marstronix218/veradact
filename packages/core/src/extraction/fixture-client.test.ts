import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyCandidates } from "@veradact/ai";
import { detectFormat, parseSource } from "@veradact/ingest";
import { modelClientChoice, modelClientFromEnv } from "./factory";
import { DEFAULT_FIXTURES_DIR, FixtureModelClient, SEED_SOURCE_FILES } from "./fixture-client";

async function parseFixture(rel: string): Promise<string> {
  const bytes = new Uint8Array(fs.readFileSync(path.join(DEFAULT_FIXTURES_DIR, rel)));
  return (await parseSource({ format: detectFormat(rel, bytes), bytes, filename: rel })).text;
}

const seedItems = JSON.parse(fs.readFileSync(path.join(DEFAULT_FIXTURES_DIR, "seed/items.json"), "utf8")) as {
  key: string;
  source: string | null;
  statement: string;
}[];

describe("FixtureModelClient", () => {
  const client = new FixtureModelClient();

  it("proposes one exactly-verified candidate per sourced seed item, in source order", async () => {
    for (const file of SEED_SOURCE_FILES) {
      const text = await parseFixture(`seed/${file}`);
      const raw = await client.extract({ sourceText: text, sourceType: "human_notes", existingItems: [], promptVersion: "extract.v1" });
      expect(raw).toHaveLength(seedItems.filter((i) => i.source === file).length);
      const verified = verifyCandidates(text, raw);
      expect(verified.counts).toMatchObject({ dropped: 0, corrected: 0, accepted: raw.length });
      expect(raw.map((c) => c.start)).toEqual([...raw.map((c) => c.start)].sort((a, b) => a - b));
      for (const c of raw) expect(c.suggested_depends_on.every((d) => /^#\d+$/.test(d))).toBe(true);
    }
  });

  it("resolves dependencies and revisions on other sources' items through existing short ids", async () => {
    const text = await parseFixture("seed/03-scope-call.srt");
    const byKey = new Map(seedItems.map((i) => [i.key, i]));
    const existingItems = [
      { short_id: "HALV-A1", kind: "assumption" as const, status: "pending", statement: byKey.get("k9")!.statement },
      { short_id: "HALV-R2", kind: "requirement" as const, status: "confirmed", statement: byKey.get("k18")!.statement },
    ];
    const raw = await client.extract({ sourceText: text, sourceType: "machine_transcript", existingItems, promptVersion: "extract.v1" });
    const k15 = raw.find((c) => c.statement === byKey.get("k15")!.statement)!;
    const k19 = raw.find((c) => c.statement === byKey.get("k19")!.statement)!;
    expect(k15.suggested_depends_on).toEqual(["HALV-A1"]);
    expect(k19.revises).toBe("HALV-R2");

    const without = await client.extract({ sourceText: text, sourceType: "machine_transcript", existingItems: [], promptVersion: "extract.v1" });
    expect(without.find((c) => c.statement === byKey.get("k15")!.statement)!.suggested_depends_on).toEqual([]);
    expect(without.find((c) => c.statement === byKey.get("k19")!.statement)!.revises).toBeNull();
  });

  it("replays the eval recordings and answers unknown text with no candidates", async () => {
    const text = await parseFixture("eval/e2-insurer-notes.md");
    const recorded = JSON.parse(fs.readFileSync(path.join(DEFAULT_FIXTURES_DIR, "eval/e2-insurer-notes.recorded.json"), "utf8")) as { candidates: unknown[] };
    const raw = await client.extract({ sourceText: text, sourceType: "human_notes", existingItems: [], promptVersion: "extract.v1" });
    expect(raw).toHaveLength(recorded.candidates.length);
    expect(await client.extract({ sourceText: "Nothing recorded here.\n", sourceType: "human_notes", existingItems: [], promptVersion: "extract.v1" })).toEqual([]);
  });

  it("answers nothing when the fixtures directory is missing", async () => {
    const missing = new FixtureModelClient({ fixturesDir: path.join(DEFAULT_FIXTURES_DIR, "does-not-exist") });
    expect(await missing.extract({ sourceText: "x", sourceType: "human_notes", existingItems: [], promptVersion: "extract.v1" })).toEqual([]);
  });
});

describe("modelClientChoice", () => {
  it("uses MODEL_CLIENT, else anthropic only when an API key is set", () => {
    expect(modelClientChoice({ MODEL_CLIENT: "fixture", ANTHROPIC_API_KEY: "sk-test" })).toBe("fixture");
    expect(modelClientChoice({ MODEL_CLIENT: " Anthropic " })).toBe("anthropic");
    expect(modelClientChoice({ ANTHROPIC_API_KEY: "sk-test" })).toBe("anthropic");
    expect(modelClientChoice({ ANTHROPIC_API_KEY: "  " })).toBe("fixture");
    expect(modelClientChoice({})).toBe("fixture");
    expect(() => modelClientChoice({ MODEL_CLIENT: "openai" })).toThrow(/MODEL_CLIENT/);
  });

  it("builds the matching client without sending anything", () => {
    expect(modelClientFromEnv({}).name).toBe("fixture");
    expect(modelClientFromEnv({ MODEL_CLIENT: "anthropic", ANTHROPIC_MODEL: "claude-test-model" }).name).toBe("claude-test-model");
  });
});
