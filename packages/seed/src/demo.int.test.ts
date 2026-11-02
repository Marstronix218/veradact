// Runs the whole demo seed against the test database (unique slug per run) and checks that the
// fixture statuses are reproduced through real events, quotes are exact, the chain verifies,
// projections rebuild identically, and the dev-only reset purges exactly the demo org.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { confirmationLink, notification, org, responseComment, sourceContent, withTenant, type Tx } from "@veradact/db";
import { adminTestDb, createTestTenant, insertRawEvents, testDb } from "@veradact/db/testing";
import { dumpProjections, loadState, rebuildProjections, sha256Hex, verifyEngagementChain, type EngagementState } from "@veradact/core";
import { DemoOrgExistsError, FIXTURE_EXTRACTION, isRevisedAfterConfirmation, seedDemo, type SeedDemoResult } from "./demo";
import { loadSeedFixtures, type SeedFixtures } from "./fixtures";
import { purgeDemoOrg } from "./reset";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

const slug = `seed-test-${randomUUID().slice(0, 8)}`;
const NOW = new Date("2026-11-02T15:00:00.000Z");
const guard = () => ({ databaseUrl: process.env.TEST_DATABASE_ADMIN_URL ?? "", nodeEnv: "test" });

let result: SeedDemoResult;
let state: EngagementState;
let fixtures: SeedFixtures;

const inOrg = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app.db, { orgId: result.orgId }, fn);

beforeAll(async () => {
  fixtures = await loadSeedFixtures();
  result = await seedDemo({ adminDb: admin.db, appDb: app.db, slug, now: NOW });
  state = await inOrg((tx) => loadState(tx, result.engagement.id));
});

describe("demo seed: ledger content", () => {
  it("records 20+ items with every status and lifecycle", () => {
    const items = [...state.items.values()];
    expect(items.length).toBeGreaterThanOrEqual(20);
    expect(items).toHaveLength(fixtures.items.length - 1); // k19 is version 2 of k18
    expect(new Set(items.filter((i) => i.lifecycle === "active").map((i) => i.status))).toEqual(new Set(["pending", "confirmed", "disputed"]));
    expect(new Set(items.map((i) => i.lifecycle))).toEqual(new Set(["active", "superseded", "withdrawn"]));
    expect(items.some(isRevisedAfterConfirmation)).toBe(true);
    expect(items.some((i) => i.needsReview)).toBe(true);
    expect(result.summary.neverSent).toBeGreaterThanOrEqual(3);
    expect(result.summary.total).toBe(items.length);
  });

  it("reproduces each fixture entry's demo_status", () => {
    const all = [...state.items.values()];
    for (const fx of fixtures.items) {
      const entry = result.fixtureItems[fx.key]!;
      const item = state.items.get(entry.itemId)!;
      expect(item.versions[entry.version - 1]!.statement, fx.key).toBe(fx.statement);
      const current = item.lifecycle === "active" && item.currentVersion === entry.version;
      switch (fx.demo_status) {
        case "confirmed":
        case "pending":
        case "disputed":
          expect({ key: fx.key, current, status: item.status }).toEqual({ key: fx.key, current: true, status: fx.demo_status });
          break;
        case "withdrawn":
          expect(item.lifecycle, fx.key).toBe("withdrawn");
          break;
        case "needs_review":
          expect({ key: fx.key, current, needsReview: item.needsReview }).toEqual({ key: fx.key, current: true, needsReview: true });
          break;
        case "superseded":
          // k21 is superseded by another item; k18's version 1 is superseded by its revision.
          expect(item.lifecycle === "superseded" || item.currentVersion > entry.version, fx.key).toBe(true);
          expect(item.responses.some((r) => r.version === entry.version && r.response === "confirmed"), fx.key).toBe(true);
          break;
        case "revised_after_confirmation": {
          const replacesConfirmed = all.some((o) => o.supersededBy === item.id && o.responses.some((r) => r.response === "confirmed"));
          expect(current, fx.key).toBe(true);
          expect(isRevisedAfterConfirmation(item) || replacesConfirmed, fx.key).toBe(true);
          break;
        }
        default:
          throw new Error(`unexpected demo_status ${fx.demo_status}`);
      }
    }
  });

  it("revises the confirmed 5:30 requirement to a pending 5:00 version and flags its dependents", () => {
    const k18 = state.items.get(result.fixtureItems.k18!.itemId)!;
    expect(result.fixtureItems.k19).toEqual({ ...result.fixtureItems.k18!, version: 2 });
    expect({ version: k18.currentVersion, status: k18.status }).toEqual({ version: 2, status: "pending" });
    expect(k18.versions[1]!.reasonCode).toBe("new_information");
    for (const key of ["k16", "k23"]) {
      const dependent = state.items.get(result.fixtureItems[key]!.itemId)!;
      expect(dependent.reviewReasons.map((r) => [r.upstreamItemId, r.cause])).toContainEqual([k18.id, "revised"]);
    }
    const k21 = state.items.get(result.fixtureItems.k21!.itemId)!;
    expect(k21.supersededBy).toBe(result.fixtureItems.k22!.itemId);
  });

  it("records provenance: fixture extraction for transcripts, manual for the notes and manual items", () => {
    for (const fx of fixtures.items) {
      const entry = result.fixtureItems[fx.key]!;
      const version = state.items.get(entry.itemId)!.versions[entry.version - 1]!;
      if (fx.source === null) {
        expect(version.manual, fx.key).not.toBeNull();
        expect(version.provenance, fx.key).toEqual({ via: "manual" });
      } else if (fixtures.sources.find((s) => s.filename === fx.source)!.type === "machine_transcript") {
        expect(version.provenance, fx.key).toMatchObject({ via: "ai_candidate", model: FIXTURE_EXTRACTION.model, prompt_version: FIXTURE_EXTRACTION.promptVersion });
      } else {
        expect({ key: fx.key, provenance: version.provenance, spans: version.spans.length }).toEqual({ key: fx.key, provenance: { via: "manual" }, spans: 1 });
      }
    }
  });

  it("records links, opens, interactions, one reminder, dispute comments and notifications", async () => {
    const links = await inOrg((tx) => tx.select().from(confirmationLink).where(eq(confirmationLink.engagementId, result.engagement.id)));
    expect(links.length).toBeGreaterThanOrEqual(5);
    expect(links.every((l) => l.emailSentAt !== null)).toBe(true);
    expect(links.filter((l) => l.reminderSentAt !== null)).toHaveLength(1);
    expect(links.filter((l) => l.openCount > 0).length).toBeGreaterThanOrEqual(3);
    expect(links.filter((l) => l.firstInteractionAt !== null).length).toBeGreaterThanOrEqual(3);

    const comments = await inOrg((tx) => tx.select({ comment: responseComment.comment }).from(responseComment));
    for (const fx of fixtures.items.filter((i) => i.demo_status === "disputed")) {
      expect(comments.some((c) => c.comment.startsWith(fx.followup!.quote)), fx.key).toBe(true);
    }
    const notes = await inOrg((tx) =>
      tx.select().from(notification).where(and(eq(notification.userId, result.users.admin.id), eq(notification.kind, "item_disputed"))),
    );
    expect(notes).toHaveLength(2);
  });

  it("cites every sourced fixture quote exactly, and every span matches its source", async () => {
    const texts = new Map(
      (await inOrg((tx) => tx.select({ id: sourceContent.sourceId, text: sourceContent.text }).from(sourceContent).where(eq(sourceContent.engagementId, result.engagement.id)))).map(
        (r) => [r.id, r.text],
      ),
    );
    expect(texts.size).toBe(3);
    for (const fx of fixtures.items.filter((i) => i.source !== null)) {
      const entry = result.fixtureItems[fx.key]!;
      const version = state.items.get(entry.itemId)!.versions[entry.version - 1]!;
      const span = version.spans.find((s) => s.source_id === result.sourceIds[fx.source!]);
      expect(span, fx.key).toBeDefined();
      expect(texts.get(span!.source_id)!.slice(span!.start, span!.end), fx.key).toBe(fx.quote);
    }
    for (const item of state.items.values()) {
      for (const version of item.versions) {
        for (const span of version.spans) {
          const text = texts.get(span.source_id)!;
          expect(sha256Hex(text)).toBe(span.source_sha256);
          expect(span.end).toBeLessThanOrEqual(text.length);
        }
      }
    }
  });
});

describe("demo seed: integrity", () => {
  it("verifies both chains and rebuilds projections identically", async () => {
    expect(result.chain.ok).toBe(true);
    expect(result.metrics.chain.ok).toBe(true);
    await inOrg(async (tx) => {
      for (const engagementId of [result.engagement.id, result.metrics.engagementId]) {
        const live = await dumpProjections(tx, engagementId);
        await rebuildProjections(tx, engagementId);
        expect(await dumpProjections(tx, engagementId)).toEqual(live);
        expect((await verifyEngagementChain(tx, engagementId)).ok).toBe(true);
      }
    });
  });

  it("refuses to seed twice; reset purges only the demo org and the seed runs again", async () => {
    await expect(seedDemo({ adminDb: admin.db, appDb: app.db, slug, now: NOW })).rejects.toBeInstanceOf(DemoOrgExistsError);

    const control = await createTestTenant(admin.db);
    await insertRawEvents(admin.db, { orgId: control.org.id, engagementId: control.engagement.id }, 3);

    const purged = await purgeDemoOrg(admin.db, slug, guard());
    expect(purged).toMatchObject({ found: true, orgId: result.orgId });
    expect(purged.deleted.event).toBeGreaterThan(0);

    const tables = await admin.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'org_id'`,
    );
    for (const { table_name } of tables) {
      const [row] = await admin.db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table_name)} where org_id = ${result.orgId}`);
      expect(row?.n, table_name).toBe(0);
    }
    expect(await admin.db.select().from(org).where(eq(org.id, result.orgId))).toHaveLength(0);
    const [controlEvents] = await admin.db.execute<{ n: number }>(sql`select count(*)::int as n from event where org_id = ${control.org.id}`);
    expect(controlEvents?.n).toBe(3);

    const again = await seedDemo({ adminDb: admin.db, appDb: app.db, slug, now: NOW });
    expect(again.orgId).not.toBe(result.orgId);
    expect(again.chain.ok).toBe(true);
    expect(again.summary).toEqual(result.summary);

    expect((await purgeDemoOrg(admin.db, slug, guard())).found).toBe(true);
    expect(await purgeDemoOrg(admin.db, slug, guard())).toEqual({ found: false, orgId: null, deleted: {} });
  });
});
