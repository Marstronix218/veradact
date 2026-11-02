// runExtraction against a concurrent redaction (ARCHITECTURE §6, §9.3): tx 2 holds the source text
// FOR SHARE, so a redaction cannot slip between reading the text and storing the candidates.
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { MockModelClient, type RawCandidate } from "@veradact/ai";
import { candidate, sourceContent, withTenant } from "@veradact/db";
import { adminTestDb, testDb } from "@veradact/db/testing";
import { createLedgerEngagement, NOTES_TEXT, Rollback } from "../test-support/ledger";
import { runExtraction } from "./run";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

const QUOTE = "Lee: Use the existing SSO provider for staff logins.";
const CANDIDATE: RawCandidate = {
  kind: "constraint",
  statement: "Staff log in through the existing SSO provider.",
  quote: QUOTE,
  start: NOTES_TEXT.indexOf(QUOTE),
  end: NOTES_TEXT.indexOf(QUOTE) + QUOTE.length,
  speaker_label: "Lee",
  confidence: 0.9,
  suggested_depends_on: [],
  revises: null,
};

describe("runExtraction and redaction", () => {
  it("tx 2 waits for a transaction that is deleting the source text before it stores candidates", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    // Another transaction has deleted the text (the first step of redactSource) but not committed.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let deleted!: () => void;
    const deleting = new Promise<void>((resolve) => (deleted = resolve));
    const holder = withTenant(app.db, { orgId: e.orgId }, async (tx) => {
      await tx.delete(sourceContent).where(eq(sourceContent.sourceId, e.sourceId));
      deleted();
      await released;
      throw new Rollback();
    }).catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
    await deleting;

    const mock = new MockModelClient([[CANDIDATE]]);
    const run = runExtraction({ ...e, db: app.db, clock: e.ctx.clock, modelClientFactory: () => mock });
    // tx 1 and the model call do not wait (plain reads see the committed text); tx 2's FOR SHARE does.
    const early = await Promise.race([run.then(() => "finished"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 750))]);
    expect(early).toBe("waiting");
    expect(mock.calls).toBe(1);

    release();
    await holder;
    expect(await run).toMatchObject({ status: "succeeded", stored: 1 });
    const stored = await withTenant(app.db, { orgId: e.orgId }, (tx) => tx.select().from(candidate).where(eq(candidate.sourceId, e.sourceId)));
    expect(stored).toHaveLength(1);
  });
});
