// The `fixture` model client (MODEL_CLIENT=fixture): answers from the synthetic fixtures so the
// demo and the e2e tests work without an API key. Nothing is sent anywhere.
//
// - fixtures/eval/*.recorded.json: replayed as recorded (deliberate flaws included).
// - fixtures/seed/items.json for the three seed sources: one candidate per sourced item, in source
//   order, with offsets computed from the parsed text. Dependencies on items of the same source
//   become `#n` ordinals; dependencies on (and revisions of) items from other sources resolve to an
//   existing item's short id by matching its statement, and are left out when there is none.
// - Any other text: no candidates.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ModelClientError, RecordedModelClient, type ExistingItem, type ExtractionInput, type ModelClient, type RawCandidate } from "@veradact/ai";
import { loadEvalFixtures } from "@veradact/ai/eval";
import { detectFormat, parseSource } from "@veradact/ingest";
import { KINDS } from "../domain";
import { logError } from "../log";

/** Repo-root `fixtures/` (this file is packages/core/src/extraction/fixture-client.ts). */
export const DEFAULT_FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../fixtures");

/** The demo engagement's sources, in ingest order. */
export const SEED_SOURCE_FILES = ["01-kickoff.vtt", "02-security-review.md", "03-scope-call.srt"] as const;

const FIXTURE_CONFIDENCE = 0.9;

const SeedItemSchema = z.object({
  key: z.string(),
  kind: z.enum(KINDS),
  statement: z.string(),
  source: z.string().nullable(),
  quote: z.string().nullable(),
  speaker: z.string().nullable(),
  depends_on: z.array(z.string()),
  revises: z.string().nullable(),
});
type SeedItem = z.infer<typeof SeedItemSchema>;

interface SeedTemplate {
  item: SeedItem & { quote: string };
  start: number;
}

interface FixtureData {
  /** Parsed seed text → its candidate templates in source order. */
  seed: Map<string, SeedTemplate[]>;
  /** Seed item key → statement (to find accepted items among the existing ones). */
  statements: Map<string, string>;
  recorded: RecordedModelClient;
}

const cache = new Map<string, Promise<FixtureData>>();

async function loadSeed(dir: string): Promise<Pick<FixtureData, "seed" | "statements">> {
  const seedDir = path.join(dir, "seed");
  const items = z.array(SeedItemSchema).parse(JSON.parse(await fs.readFile(path.join(seedDir, "items.json"), "utf8")));
  const seed = new Map<string, SeedTemplate[]>();
  for (const file of SEED_SOURCE_FILES) {
    const bytes = new Uint8Array(await fs.readFile(path.join(seedDir, file)));
    const parsed = await parseSource({ format: detectFormat(file, bytes), bytes, filename: file });
    const templates = items
      .filter((i): i is SeedItem & { quote: string } => i.source === file && i.quote !== null)
      .map((i) => ({ item: i, start: parsed.text.indexOf(i.quote) }))
      .filter((t) => t.start !== -1)
      .sort((a, b) => a.start - b.start);
    seed.set(parsed.text, templates);
  }
  return { seed, statements: new Map(items.map((i) => [i.key, i.statement])) };
}

async function load(dir: string): Promise<FixtureData> {
  try {
    const [{ seed, statements }, evalFixtures] = await Promise.all([loadSeed(dir), loadEvalFixtures(path.join(dir, "eval"))]);
    const recordings = evalFixtures.flatMap((f) => (f.recorded ? [{ sourceText: f.parsed.text, candidates: f.recorded.candidates }] : []));
    return { seed, statements, recorded: new RecordedModelClient(recordings, "fixture") };
  } catch (error) {
    // Fixtures missing (e.g. a deployment without the repo's fixtures/): answer nothing.
    logError("extraction.fixtures_unavailable", error);
    return { seed: new Map(), statements: new Map(), recorded: new RecordedModelClient([], "fixture") };
  }
}

function seedCandidates(templates: readonly SeedTemplate[], existing: readonly ExistingItem[], statements: ReadonlyMap<string, string>): RawCandidate[] {
  const ordinalByKey = new Map(templates.map((t, i) => [t.item.key, i + 1]));
  const shortIdOf = (key: string): string | null => {
    const statement = statements.get(key);
    return existing.find((e) => e.statement === statement)?.short_id ?? null;
  };
  return templates.map(({ item, start }) => ({
    kind: item.kind,
    statement: item.statement,
    quote: item.quote,
    start,
    end: start + item.quote.length,
    speaker_label: item.speaker,
    confidence: FIXTURE_CONFIDENCE,
    suggested_depends_on: item.depends_on.flatMap((key) => {
      const ordinal = ordinalByKey.get(key);
      if (ordinal !== undefined) return [`#${ordinal}`];
      const shortId = shortIdOf(key);
      return shortId ? [shortId] : [];
    }),
    revises: item.revises ? shortIdOf(item.revises) : null,
  }));
}

/** A `ModelClient` over the repository fixtures (see the module comment). `name` is `fixture`. */
export class FixtureModelClient implements ModelClient {
  readonly name = "fixture";
  private readonly dir: string;

  constructor(options: { fixturesDir?: string } = {}) {
    this.dir = options.fixturesDir ?? DEFAULT_FIXTURES_DIR;
  }

  async extract(input: ExtractionInput): Promise<RawCandidate[]> {
    let pending = cache.get(this.dir);
    if (!pending) {
      pending = load(this.dir);
      cache.set(this.dir, pending);
    }
    const data = await pending;
    const templates = data.seed.get(input.sourceText);
    if (templates) return seedCandidates(templates, input.existingItems, data.statements);
    try {
      return await data.recorded.extract(input);
    } catch (error) {
      if (error instanceof ModelClientError && error.code === "no_recording") return [];
      throw error;
    }
  }
}
