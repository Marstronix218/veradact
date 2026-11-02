// Phase 2 acceptance criterion: every accepted item from the seed transcripts links to a verified
// quote. The three seed sources go through parseSource → ingestSource (with the attestation from
// fixtures/seed/participants.json) → runExtraction (fixture model client) → acceptCandidate.
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { extractionRun, sourceContent } from "@veradact/db";
import { adminTestDb, testDb } from "@veradact/db/testing";
import { detectFormat, parseSource } from "@veradact/ingest";
import { createEngagement, ingestSource } from "../commands";
import { sha256Hex, type SourceType } from "../domain";
import { getItemDetail, listItems } from "../queries";
import { acceptCandidate, listCandidates, type CandidateView } from "../review";
import { createLedgerTenant, inTenant, ledgerContext } from "../test-support/ledger";
import { DEFAULT_FIXTURES_DIR, FixtureModelClient, SEED_SOURCE_FILES } from "./fixture-client";
import { runExtraction } from "./run";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

const seedDir = path.join(DEFAULT_FIXTURES_DIR, "seed");
const participants = JSON.parse(fs.readFileSync(path.join(seedDir, "participants.json"), "utf8")) as Record<
  string,
  { date: string; type: SourceType; jurisdiction: string; consent_attested: boolean; participants: { name: string }[] }
>;
const seedItems = JSON.parse(fs.readFileSync(path.join(seedDir, "items.json"), "utf8")) as {
  key: string;
  statement: string;
  source: string | null;
  depends_on: string[];
  revises: string | null;
}[];

function occurrences(text: string, needle: string): number {
  let n = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) n += 1;
  return n;
}

/** Accept order that lets `#n` suggestions resolve: a candidate after the ones it points at. */
function dependencyOrder(candidates: readonly CandidateView[]): CandidateView[] {
  const byOrdinal = new Map(candidates.map((c) => [c.ordinal, c]));
  const done = new Set<string>();
  const out: CandidateView[] = [];
  const visit = (c: CandidateView) => {
    if (done.has(c.id)) return;
    done.add(c.id);
    for (const d of c.suggestedDependencies) {
      const m = /^#(\d+)$/.exec(d.ref);
      const upstream = m ? byOrdinal.get(Number(m[1])) : undefined;
      if (upstream) visit(upstream);
    }
    out.push(c);
  };
  candidates.forEach(visit);
  return out;
}

describe("seed transcripts → verified quotes (Phase 2 acceptance)", () => {
  it("links every accepted item version to a quote that exists exactly in its source", async () => {
    const tenant = await createLedgerTenant(admin.db);
    const ctx = ledgerContext(app, tenant, new Date("2026-09-25T13:00:00.000Z"));
    const { engagementId } = await createEngagement(ctx, {
      name: "Dispatch assistant pilot",
      clientName: "Halvorsen Freight",
      shortCode: "HALV",
      timeZone: "America/New_York",
    });

    const accepted: { candidate: CandidateView; itemId: string; version: number }[] = [];
    for (const file of SEED_SOURCE_FILES) {
      const meta = participants[file]!;
      const bytes = new Uint8Array(fs.readFileSync(path.join(seedDir, file)));
      const format = detectFormat(file, bytes);
      const parsed = await parseSource({ format, bytes, filename: file });
      const { sourceId } = await ingestSource(ctx, {
        engagementId,
        parsed,
        title: file,
        filename: file,
        format,
        sourceType: meta.type,
        occurredAt: new Date(`${meta.date}T13:00:00.000Z`),
        participants: meta.participants.map((p) => p.name),
        attestation: { allParticipantsConsented: meta.consent_attested, jurisdictions: [meta.jurisdiction], jurisdictionsKnown: true },
      });

      const result = await runExtraction({
        db: app.db,
        orgId: tenant.orgId,
        userId: tenant.userId,
        engagementId,
        sourceId,
        clock: ctx.clock,
        modelClientFactory: () => new FixtureModelClient(),
      });
      const expected = seedItems.filter((i) => i.source === file).length;
      expect(result).toMatchObject({ status: "succeeded", model: "fixture", proposed: expected, stored: expected, dropped: 0, corrected: 0, notes: [] });

      const [group] = await inTenant(app, tenant.orgId, (tx) => listCandidates(tx, engagementId));
      expect(group?.sourceId).toBe(sourceId);
      expect(group?.candidates).toHaveLength(expected);
      for (const c of dependencyOrder(group!.candidates)) {
        const r = await acceptCandidate(ctx, { candidateId: c.id, engagementId });
        expect(r.notes).toEqual([]);
        accepted.push({ candidate: c, itemId: r.itemId, version: r.version });
      }
      const run = await inTenant(app, tenant.orgId, (tx) => tx.select().from(extractionRun).where(eq(extractionRun.id, result.runId)));
      expect(run[0]).toMatchObject({ status: "succeeded", proposedCount: expected, droppedCount: 0, correctedCount: 0, errorCode: null });
    }

    // 22 sourced seed items; two of them revise earlier items (new versions, not new items).
    const sourced = seedItems.filter((i) => i.source !== null);
    expect(accepted).toHaveLength(sourced.length);
    const revisions = sourced.filter((i) => i.revises !== null);
    expect(accepted.filter((a) => a.version === 2)).toHaveLength(revisions.length);

    await inTenant(app, tenant.orgId, async (tx) => {
      const texts = new Map((await tx.select().from(sourceContent).where(eq(sourceContent.engagementId, engagementId))).map((s) => [s.sourceId, s.text]));
      const items = await listItems(tx, engagementId);
      expect(items).toHaveLength(sourced.length - revisions.length);

      // The candidate behind each accepted version: its quote is the version's verified span.
      for (const { candidate, itemId, version } of accepted) {
        const detail = (await getItemDetail(tx, engagementId, itemId))!;
        const v = detail.versions.find((x) => x.version === version)!;
        expect(v.provenance).toMatchObject({ via: "ai_candidate", candidate_id: candidate.id, model: "fixture", prompt_version: "extract.v1", edited: false });
        expect(v.manual).toBeNull();
        expect(v.spans).toHaveLength(1);
        const span = v.spans[0]!;
        const text = texts.get(span.sourceId)!;
        expect(sha256Hex(text)).toBe(span.sourceSha256);
        expect(text.slice(span.start, span.end)).toBe(candidate.quote);
        expect(span.quoteState).toBe("verified");
        expect(span.quote).toBe(candidate.quote);
        expect(occurrences(text, candidate.quote)).toBe(1);
      }

      // Every version of every item in the engagement is sourced by verified quotes.
      for (const i of items) {
        const detail = (await getItemDetail(tx, engagementId, i.id))!;
        for (const v of detail.versions) {
          expect(v.spans.length).toBeGreaterThanOrEqual(1);
          for (const span of v.spans) {
            const text = texts.get(span.sourceId)!;
            expect(sha256Hex(text)).toBe(span.sourceSha256);
            expect(span.quote).toBe(text.slice(span.start, span.end));
          }
        }
      }

      // Cross-source suggestions resolved: k15 (scope call) depends on k9 (kickoff).
      const statementOf = (key: string) => seedItems.find((s) => s.key === key)!.statement;
      const k15 = items.find((x) => x.statement === statementOf("k15"))!;
      const k9 = items.find((x) => x.statement === statementOf("k9"))!;
      const k15Detail = (await getItemDetail(tx, engagementId, k15.id))!;
      expect(k15Detail.dependencies.map((d) => d.id)).toEqual([k9.id]);
      // k19 revised k18's item: version 2 cites the scope call only.
      const k19 = items.find((x) => x.statement === statementOf("k19"))!;
      expect(k19.currentVersion).toBe(2);
    });
  });
});
