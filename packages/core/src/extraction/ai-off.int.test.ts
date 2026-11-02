// Phase 2 acceptance criterion: with AI off, a mocked model client records zero calls
// (CLAUDE.md invariant 9). The check runs inside the tenant transaction before the factory is
// called, so no client is even constructed; a flag flipped off during the model call discards
// the results.
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { MockModelClient, type RawCandidate } from "@veradact/ai";
import { auditLog, candidate, extractionRun } from "@veradact/db";
import { adminTestDb, createTestOrg, createTestUser, testDb } from "@veradact/db/testing";
import { createEngagement, ingestSource } from "../commands";
import { AiDisabledError } from "../errors";
import { updateOrgSettings } from "../org";
import { createLedgerEngagement, inTenant, ledgerContext, NOTES_TEXT } from "../test-support/ledger";
import { setEngagementAiEnabled } from "./ai-settings";
import { runExtraction, type ModelClientFactory } from "./run";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

const QUOTE = "The dispatch dashboard must refresh every five minutes.";
const CANDIDATE: RawCandidate = {
  kind: "requirement",
  statement: "The dispatch dashboard refreshes every five minutes.",
  quote: QUOTE,
  start: NOTES_TEXT.indexOf(QUOTE),
  end: NOTES_TEXT.indexOf(QUOTE) + QUOTE.length,
  speaker_label: "Dana",
  confidence: 0.8,
  suggested_depends_on: [],
  revises: null,
};

function spyFactory(script: ConstructorParameters<typeof MockModelClient>[0] = [[CANDIDATE]]) {
  const mock = new MockModelClient(script);
  const spy = { invocations: 0, mock, factory: (() => {
    spy.invocations += 1;
    return mock;
  }) as ModelClientFactory };
  return spy;
}

async function countRows(orgId: string, engagementId: string) {
  return inTenant(app, orgId, async (tx) => ({
    runs: (await tx.select().from(extractionRun).where(eq(extractionRun.engagementId, engagementId))).length,
    candidates: (await tx.select().from(candidate).where(eq(candidate.engagementId, engagementId))).length,
  }));
}

describe("AI off → zero model calls (Phase 2 acceptance)", () => {
  it("org AI off: AiDisabledError, the factory is never invoked and the client records zero calls", async () => {
    const o = await createTestOrg(admin.db, { aiEnabled: false });
    const u = await createTestUser(admin.db, { orgId: o.id });
    const ctx = ledgerContext(app, { orgId: o.id, userId: u.id });
    const { engagementId } = await createEngagement(ctx, { name: "AI-free pilot", clientName: "Fictional Client Co", shortCode: "NOAI", timeZone: "UTC" });
    const { sourceId } = await ingestSource(ctx, {
      engagementId,
      parsed: { text: NOTES_TEXT, rawText: NOTES_TEXT, segments: [] },
      format: "md",
      sourceType: "human_notes",
      occurredAt: new Date("2026-02-20T14:00:00.000Z"),
      attestation: { allParticipantsConsented: null, jurisdictions: [], jurisdictionsKnown: false },
    });

    const spy = spyFactory();
    const error = await runExtraction({ db: app.db, orgId: o.id, userId: u.id, engagementId, sourceId, clock: ctx.clock, modelClientFactory: spy.factory }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AiDisabledError);
    expect((error as AiDisabledError).code).toBe("ai_disabled");
    expect((error as AiDisabledError).scope).toBe("org");
    expect(spy.invocations).toBe(0);
    expect(spy.mock.calls).toBe(0);
    expect(await countRows(o.id, engagementId)).toEqual({ runs: 0, candidates: 0 });
  });

  it("engagement AI off: AiDisabledError with zero calls; toggling writes ai.toggle audit rows", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    expect(await setEngagementAiEnabled(e.ctx, { engagementId: e.engagementId, enabled: false })).toEqual({ before: true, after: false });
    // A no-op toggle writes nothing.
    expect(await setEngagementAiEnabled(e.ctx, { engagementId: e.engagementId, enabled: false })).toEqual({ before: false, after: false });

    const spy = spyFactory();
    const error = await runExtraction({ ...e, db: app.db, clock: e.ctx.clock, modelClientFactory: spy.factory }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AiDisabledError);
    expect((error as AiDisabledError).scope).toBe("engagement");
    expect(spy.invocations).toBe(0);
    expect(spy.mock.calls).toBe(0);
    expect(await countRows(e.orgId, e.engagementId)).toEqual({ runs: 0, candidates: 0 });

    // Org switch (admin) audits too.
    await updateOrgSettings({ db: app.db, ctx: { orgId: e.orgId, userId: e.userId, role: "admin" }, clock: e.ctx.clock, patch: { aiEnabled: false } });
    const audits = await inTenant(app, e.orgId, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.orgId, e.orgId), eq(auditLog.action, "ai.toggle"))).orderBy(auditLog.createdAt),
    );
    expect(audits.map((a) => ({ targetType: a.targetType, targetId: a.targetId, metadata: a.metadata, actor: a.actorUserId }))).toEqual([
      { targetType: "engagement", targetId: e.engagementId, metadata: { scope: "engagement", before: true, after: false }, actor: e.userId },
      { targetType: "org", targetId: e.orgId, metadata: { scope: "org", before: true, after: false }, actor: e.userId },
    ]);

    // Turning it back on (engagement only) still leaves the org switch off: still zero calls.
    await setEngagementAiEnabled(e.ctx, { engagementId: e.engagementId, enabled: true });
    const again = spyFactory();
    await expect(runExtraction({ ...e, db: app.db, clock: e.ctx.clock, modelClientFactory: again.factory })).rejects.toBeInstanceOf(AiDisabledError);
    expect(again.mock.calls).toBe(0);
  });

  it("with AI on the model is called once with the stored text", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const spy = spyFactory();
    const result = await runExtraction({ ...e, db: app.db, clock: e.ctx.clock, modelClientFactory: spy.factory });
    expect(result).toMatchObject({ status: "succeeded", model: "mock", proposed: 1, stored: 1, dropped: 0 });
    expect(spy.invocations).toBe(1);
    expect(spy.mock.calls).toBe(1);
    expect(spy.mock.callLog[0]).toMatchObject({ sourceText: NOTES_TEXT, sourceType: "human_notes", existingItems: [], promptVersion: "extract.v1" });
  });

  it("discards the results when AI is switched off between tx 1 and tx 2", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const spy = spyFactory([
      async () => {
        // tx 1 has committed; the member switches AI off while the model is working.
        await setEngagementAiEnabled({ ...e.ctx }, { engagementId: e.engagementId, enabled: false });
        return [CANDIDATE];
      },
    ]);
    const result = await runExtraction({ ...e, db: app.db, clock: e.ctx.clock, modelClientFactory: spy.factory });
    expect(result).toMatchObject({ status: "discarded", errorCode: "ai_disabled", stored: 0, proposed: 1 });
    expect(spy.mock.calls).toBe(1);
    const rows = await inTenant(app, e.orgId, async (tx) => ({
      runs: await tx.select().from(extractionRun).where(eq(extractionRun.id, result.runId)),
      candidates: await tx.select().from(candidate).where(eq(candidate.engagementId, e.engagementId)),
    }));
    expect(rows.candidates).toHaveLength(0);
    expect(rows.runs[0]).toMatchObject({ status: "discarded", errorCode: "ai_disabled", proposedCount: 0 });
    expect(rows.runs[0]!.finishedAt).not.toBeNull();
  });

  it("stops before the model call when AI is switched off after tx 1 (while the client is built)", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const mock = new MockModelClient([[CANDIDATE]]);
    const result = await runExtraction({
      ...e,
      db: app.db,
      clock: e.ctx.clock,
      modelClientFactory: async () => {
        // tx 1 has checked the flags; the member switches AI off before the text is sent.
        await setEngagementAiEnabled({ ...e.ctx }, { engagementId: e.engagementId, enabled: false });
        return mock;
      },
    });
    expect(result).toMatchObject({ status: "discarded", errorCode: "ai_disabled", proposed: 0, stored: 0 });
    expect(mock.calls).toBe(0);
    const runs = await inTenant(app, e.orgId, (tx) => tx.select().from(extractionRun).where(eq(extractionRun.id, result.runId)));
    expect(runs[0]).toMatchObject({ status: "discarded", errorCode: "ai_disabled" });
  });

  it("records a failed run with the model error code and keeps the ingest", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const { ModelClientError } = await import("@veradact/ai");
    const spy = spyFactory([new ModelClientError("rate_limited", { status: 429 })]);
    const result = await runExtraction({ ...e, db: app.db, clock: e.ctx.clock, modelClientFactory: spy.factory });
    expect(result).toMatchObject({ status: "failed", errorCode: "rate_limited", stored: 0 });
    const runs = await inTenant(app, e.orgId, (tx) => tx.select().from(extractionRun).where(eq(extractionRun.id, result.runId)));
    expect(runs[0]).toMatchObject({ status: "failed", errorCode: "rate_limited", model: "mock" });
    expect(await inTenant(app, e.orgId, (tx) => tx.select().from(candidate).where(eq(candidate.engagementId, e.engagementId)))).toHaveLength(0);
  });

  it("records a failed run when the client cannot be constructed", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const result = await runExtraction({
      ...e,
      db: app.db,
      clock: e.ctx.clock,
      modelClientFactory: () => {
        throw new Error("misconfigured");
      },
    });
    expect(result).toMatchObject({ status: "failed", errorCode: "client_unavailable" });
  });
});
