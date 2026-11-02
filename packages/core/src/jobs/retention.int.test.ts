// Data retention (ARCHITECTURE §6): sources older than `org.retention_days` (by `recorded_at`) are
// redacted through `redactSource` with the system actor. Runs are limited to each test's orgs, and
// the global rate-limit prune is off except in its own test, because test files share one database.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { auditLog, candidate, org, rateLimitBucket, source, sourceContent, withTenant } from "@veradact/db";
import { adminTestDb, testDb } from "@veradact/db/testing";
import { createItem } from "../commands";
import { ingestSource } from "../commands/sources";
import { steppingClock } from "../domain/testing";
import { getItemDetail } from "../queries";
import { checkRateLimit, rateLimitKey } from "../security/rate-limit";
import { dumpProjections, readEngagementHead, readEvents, rebuildProjections, verifyEngagementChain } from "../store";
import { createLedgerEngagement, NOTES_TEXT } from "../test-support/ledger";
import { runRetention } from "./retention";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

const QUOTE = "Invoices are exported nightly to the carrier portal.";
const RECENT_TEXT = "Follow-up call.\nLee: Carrier invoices go out at 02:00 local time.\n";
// The kickoff source is recorded on 2026-03-02 and the follow-up on 2026-03-20. With a 10-day
// window, a run on 2026-03-25 has its cutoff on 2026-03-15: the first is due, the second is not.
const RUN_AT = new Date("2026-03-25T15:00:00.000Z");

/** Engagement with an old source (cited by an item, with candidates) and a recent one. */
async function engagementWithSources() {
  const e = await createLedgerEngagement(app, admin.db, new Date("2026-03-02T15:00:00.000Z"));
  const item = await createItem(e.ctx, { engagementId: e.engagementId, kind: "requirement", statement: "Nightly invoice export", spans: [{ sourceId: e.sourceId, quote: QUOTE }] });
  const start = NOTES_TEXT.indexOf(QUOTE);
  await withTenant(app.db, { orgId: e.orgId }, async (tx) => {
    const base = {
      orgId: e.orgId,
      engagementId: e.engagementId,
      sourceId: e.sourceId,
      extractionRunId: randomUUID(),
      kind: "requirement" as const,
      statement: "Synthetic candidate",
      quote: QUOTE,
      start,
      end: start + QUOTE.length,
      verification: "exact" as const,
      createdAt: new Date("2026-03-02T15:10:00.000Z"),
    };
    await tx.insert(candidate).values([
      { ...base, ordinal: 1, status: "pending" },
      { ...base, ordinal: 2, status: "accepted", resultingItemId: item.itemId },
    ]);
  });
  const later = { ...e.ctx, clock: steppingClock(new Date("2026-03-20T15:00:00.000Z")) };
  const recent = await ingestSource(later, {
    engagementId: e.engagementId,
    parsed: { text: RECENT_TEXT, rawText: RECENT_TEXT, segments: [] },
    title: "Follow-up notes",
    format: "md",
    sourceType: "human_notes",
    occurredAt: new Date("2026-03-20T14:00:00.000Z"),
    attestation: { allParticipantsConsented: null, jurisdictions: [], jurisdictionsKnown: false },
  });
  return { e, item, recentSourceId: recent.sourceId };
}

async function setRetentionDays(orgId: string, days: number | null): Promise<void> {
  await admin.db.update(org).set({ retentionDays: days }).where(eq(org.id, orgId));
}

/** Everything a retention run could change in one org's engagement. */
async function snapshot(orgId: string, engagementId: string) {
  return withTenant(app.db, { orgId }, async (tx) => ({
    head: await readEngagementHead(tx, engagementId),
    projections: await dumpProjections(tx, engagementId),
    contents: (await tx.select({ id: sourceContent.sourceId }).from(sourceContent)).map((r) => r.id).sort(),
    candidates: (await tx.select({ id: candidate.id }).from(candidate)).length,
  }));
}

describe("runRetention", () => {
  it("redacts sources past the window with the system actor, keeps recent ones and spans; the chain verifies and rebuild equals live", async () => {
    const { e, item, recentSourceId } = await engagementWithSources();
    await setRetentionDays(e.orgId, 10);
    const detailBefore = await withTenant(app.db, { orgId: e.orgId }, (tx) => getItemDetail(tx, e.engagementId, item.itemId));
    const eventsBefore = await withTenant(app.db, { orgId: e.orgId }, (tx) => readEvents(tx, e.engagementId));

    expect(await runRetention({ db: app.db, now: RUN_AT, onlyOrgIds: [e.orgId], pruneRateLimits: false })).toEqual({
      orgs: 1,
      redacted: 1,
      failed: 0,
      rateLimitBucketsPruned: 0,
    });

    await withTenant(app.db, { orgId: e.orgId }, async (tx) => {
      const events = await readEvents(tx, e.engagementId);
      expect(events.slice(0, eventsBefore.length)).toEqual(eventsBefore);
      expect(events.slice(eventsBefore.length)).toMatchObject([
        { type: "source_redacted", actor: { type: "system", id: null }, payload: { source_id: e.sourceId, reason_code: "retention" }, recordedAt: RUN_AT },
      ]);
      const sources = await tx.select({ id: source.id, redactedAt: source.redactedAt, reason: source.redactionReason }).from(source).where(eq(source.engagementId, e.engagementId));
      expect(sources.find((s) => s.id === e.sourceId)).toMatchObject({ redactedAt: RUN_AT, reason: "retention" });
      expect(sources.find((s) => s.id === recentSourceId)).toMatchObject({ redactedAt: null, reason: null });
      expect((await tx.select({ id: sourceContent.sourceId }).from(sourceContent)).map((r) => r.id)).toEqual([recentSourceId]);
      // Pending and accepted candidates both copied the old source's text.
      expect(await tx.select().from(candidate).where(eq(candidate.sourceId, e.sourceId))).toEqual([]);
      expect(await tx.select({ actor: auditLog.actorUserId, metadata: auditLog.metadata }).from(auditLog).where(and(eq(auditLog.action, "source.redact"), eq(auditLog.targetId, e.sourceId)))).toEqual([
        { actor: null, metadata: { reason_code: "retention" } },
      ]);

      // The item version keeps its spans and content hash; only the quote is gone.
      const detail = await getItemDetail(tx, e.engagementId, item.itemId);
      const [before, after] = [detailBefore!.versions[0]!, detail!.versions[0]!];
      expect(after.contentHash).toBe(item.contentHash);
      expect(after.spans.map((s) => [s.sourceId, s.start, s.end])).toEqual(before.spans.map((s) => [s.sourceId, s.start, s.end]));
      expect(after.spans[0]).toMatchObject({ quote: null, quoteState: "redacted", sourceRedactedAt: RUN_AT });

      expect(await verifyEngagementChain(tx, e.engagementId)).toMatchObject({ ok: true, headSeq: eventsBefore.length + 1 });
      const live = await dumpProjections(tx, e.engagementId);
      await rebuildProjections(tx, e.engagementId);
      expect(await dumpProjections(tx, e.engagementId)).toEqual(live);
    });

    // Idempotent: a second run (even much later) finds nothing new in the window and writes nothing.
    const settled = await snapshot(e.orgId, e.engagementId);
    expect(await runRetention({ db: app.db, now: new Date("2026-03-26T15:00:00.000Z"), onlyOrgIds: [e.orgId], pruneRateLimits: false })).toMatchObject({ orgs: 1, redacted: 0, failed: 0 });
    expect(await snapshot(e.orgId, e.engagementId)).toEqual(settled);
  });

  it("leaves orgs without a retention window untouched", async () => {
    const kept = await engagementWithSources();
    const due = await engagementWithSources();
    await setRetentionDays(due.e.orgId, 10);
    const before = await snapshot(kept.e.orgId, kept.e.engagementId);

    const result = await runRetention({ db: app.db, now: new Date("2027-01-01T00:00:00.000Z"), onlyOrgIds: [kept.e.orgId, due.e.orgId], pruneRateLimits: false });
    expect(result).toMatchObject({ orgs: 1, redacted: 2, failed: 0 });
    expect(await snapshot(kept.e.orgId, kept.e.engagementId)).toEqual(before);
    expect(before.contents).toHaveLength(2);
    expect(before.candidates).toBe(2);
  });

  it("measures the window from recorded_at, not from the source date", async () => {
    // The kickoff source happened on 2026-02-20 but entered the ledger on 2026-03-02.
    const { e } = await engagementWithSources();
    await setRetentionDays(e.orgId, 30);
    const at = (iso: string) => runRetention({ db: app.db, now: new Date(iso), onlyOrgIds: [e.orgId], pruneRateLimits: false });
    expect(await at("2026-03-25T15:00:00.000Z")).toMatchObject({ redacted: 0 });
    expect(await at("2026-04-02T15:00:00.000Z")).toMatchObject({ redacted: 1 });
  });

  it("prunes rate-limit windows older than a day", async () => {
    const id = `retention-${randomUUID()}`;
    const old = new Date("2001-01-01T00:00:00.000Z");
    await checkRateLimit(app.db, { scope: "client_page_ip", id, limit: 5, windowSeconds: 60, now: old });
    await checkRateLimit(app.db, { scope: "client_page_ip", id, limit: 5, windowSeconds: 60, now: new Date("2001-01-02T11:59:00.000Z") });
    const key = rateLimitKey("client_page_ip", 60, id);

    // No orgs in scope; the prune is global with its cutoff a day before `now` (2001-01-01T12:00Z).
    const result = await runRetention({ db: app.db, now: new Date("2001-01-02T12:00:00.000Z"), onlyOrgIds: [] });
    expect(result).toMatchObject({ orgs: 0, redacted: 0 });
    expect(result.rateLimitBucketsPruned).toBeGreaterThanOrEqual(1);
    const rows = await admin.db.select().from(rateLimitBucket).where(eq(rateLimitBucket.key, key));
    expect(rows.map((r) => r.windowStart.toISOString())).toEqual(["2001-01-02T11:59:00.000Z"]);
  });
});
