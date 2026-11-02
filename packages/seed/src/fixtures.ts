// Loads the synthetic demo fixtures in `fixtures/seed` (see fixtures/README.md). Everything there
// is fictional; `node fixtures/check-fixtures.mjs` validates the files themselves.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { KINDS, type Kind, type SourceType } from "@veradact/core";

/** Repo-root `fixtures/seed` (this file is packages/seed/src/fixtures.ts). */
export const SEED_FIXTURES_DIR = fileURLToPath(new URL("../../../fixtures/seed/", import.meta.url));

export interface FixtureItem {
  key: string;
  kind: Kind;
  statement: string;
  /** Source file name, or null for manual items. */
  source: string | null;
  quote: string | null;
  speaker: string | null;
  depends_on: string[];
  revises: string | null;
  superseded_by: string | null;
  demo_status: string;
  /** The later quote that disputes or retracts the item (disputed and withdrawn items). */
  followup?: { source: string; quote: string; speaker: string };
}

export interface FixtureContact {
  name: string;
  email: string;
  title: string;
  organization: string;
}

export interface FixtureSourceMeta {
  /** `YYYY-MM-DD`, the day the conversation happened. */
  date: string;
  type: SourceType;
  jurisdiction: string;
  consent_attested: boolean;
  author?: string;
  participants: { name: string; org: string; role: string }[];
}

export interface FixtureSource extends FixtureSourceMeta {
  filename: string;
  bytes: Uint8Array;
}

export interface SeedFixtures {
  items: FixtureItem[];
  contacts: FixtureContact[];
  /** In ingest order (file name order: 01-, 02-, 03-). */
  sources: FixtureSource[];
}

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(`${SEED_FIXTURES_DIR}${name}`, "utf8")) as T;
}

/** Reads and sanity-checks the seed fixtures; throws on a structural problem. */
export async function loadSeedFixtures(): Promise<SeedFixtures> {
  const [items, contacts, participants] = await Promise.all([
    readJson<FixtureItem[]>("items.json"),
    readJson<FixtureContact[]>("contacts.json"),
    readJson<Record<string, FixtureSourceMeta>>("participants.json"),
  ]);
  const filenames = Object.keys(participants).sort();
  const sources = await Promise.all(
    filenames.map(async (filename) => ({
      ...participants[filename]!,
      filename,
      bytes: new Uint8Array(await readFile(`${SEED_FIXTURES_DIR}${filename}`)),
    })),
  );

  const keys = new Set(items.map((i) => i.key));
  for (const item of items) {
    if (!(KINDS as readonly string[]).includes(item.kind)) throw new Error(`fixtures: ${item.key} has an unknown kind`);
    if ((item.source === null) !== (item.quote === null)) throw new Error(`fixtures: ${item.key} needs both source and quote, or neither`);
    if (item.source !== null && !participants[item.source]) throw new Error(`fixtures: ${item.key} cites an unknown source`);
    for (const ref of [...item.depends_on, item.revises, item.superseded_by]) {
      if (ref !== null && !keys.has(ref)) throw new Error(`fixtures: ${item.key} refers to unknown item ${ref}`);
    }
  }
  return { items, contacts, sources };
}
