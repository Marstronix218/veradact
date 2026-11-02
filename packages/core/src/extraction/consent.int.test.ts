// Phase 2 acceptance criterion: ingest is blocked for an unattested machine transcript involving an
// all-party-consent state (ARCHITECTURE §9.2, D-013), through the real parser.
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { adminTestDb, testDb } from "@veradact/db/testing";
import { detectFormat, parseSource } from "@veradact/ingest";
import { ingestSource, type IngestSourceInput } from "../commands";
import { ConsentBlockedError } from "../errors";
import { createLedgerEngagement, type LedgerEngagement } from "../test-support/ledger";
import { DEFAULT_FIXTURES_DIR } from "./fixture-client";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

async function upload(e: LedgerEngagement, file: string, overrides: Partial<IngestSourceInput>): Promise<IngestSourceInput> {
  const bytes = new Uint8Array(fs.readFileSync(path.join(DEFAULT_FIXTURES_DIR, "seed", file)));
  const format = detectFormat(file, bytes);
  return {
    engagementId: e.engagementId,
    parsed: await parseSource({ format, bytes, filename: file }),
    title: file,
    filename: file,
    format,
    sourceType: "machine_transcript",
    occurredAt: new Date("2026-09-08T13:00:00.000Z"),
    participants: ["Priya Raman", "Dana Whitcombe"],
    attestation: { allParticipantsConsented: null, jurisdictions: ["OH", "CA"], jurisdictionsKnown: true },
    ...overrides,
  };
}

describe("consent block (Phase 2 acceptance)", () => {
  it("blocks an unattested machine transcript with a participant in California and explains why", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const error = await ingestSource(e.ctx, await upload(e, "03-scope-call.srt", {})).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConsentBlockedError);
    const blocked = error as ConsentBlockedError;
    expect(blocked.rule).toBe("all_party_state_without_consent");
    expect(blocked.blockingStates).toEqual(["CA"]);
    expect(blocked.explanation).toMatch(/California/);
  });

  it("allows it once every participant's consent is attested", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const input = await upload(e, "03-scope-call.srt", { attestation: { allParticipantsConsented: true, jurisdictions: ["OH", "CA"], jurisdictionsKnown: true } });
    const { consent } = await ingestSource(e.ctx, input);
    expect(consent).toMatchObject({ decision: "allowed", rule: "consent_attested" });
  });

  it("allows human-written notes without a consent attestation", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const { consent } = await ingestSource(e.ctx, await upload(e, "02-security-review.md", { sourceType: "human_notes" }));
    expect(consent).toMatchObject({ decision: "allowed", effectiveSourceType: "human_notes" });
  });

  it("still blocks a .vtt transcript that the uploader labels as human notes", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const error = await ingestSource(e.ctx, await upload(e, "01-kickoff.vtt", { sourceType: "human_notes" })).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConsentBlockedError);
    expect((error as ConsentBlockedError).blockingStates).toEqual(["CA"]);
  });
});
