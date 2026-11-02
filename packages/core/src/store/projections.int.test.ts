// Invariant 2 (projections are a pure function of the log), property-tested against real Postgres:
// random valid event sequences (domain arbitraries) are appended through `appendEvents` in random
// batches with the generator's stepping clock; the live projection tables must equal
// `projectRows(fold(readEvents))`, and a rebuild (even after the tables were damaged) must restore
// exactly the live dump. ≥ 1,000 events in total across runs (ARCHITECTURE §5.3).
import fc from "fast-check";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { item, itemDependency, source } from "@veradact/db";
import { adminTestDb, testDb } from "@veradact/db/testing";
import { fold, projectRows } from "../domain";
import { arbEngagementLog, clockFrom } from "../domain/testing";
import { inRolledBackTenant, insertGeneratedFixtures } from "../test-support/ledger";
import { appendEvents, dumpProjections, readEvents, rebuildProjections, verifyEngagementChain } from "./index";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

const MIN_TOTAL_EVENTS = 1000;

describe("projections are a pure function of the log (property test)", () => {
  it(
    `live tables == rebuild == projectRows(fold(events)) over >= ${MIN_TOTAL_EVENTS} generated events`,
    async () => {
      let totalEvents = 0;
      let runs = 0;
      const started = Date.now();
      await fc.assert(
        fc.asyncProperty(
          arbEngagementLog({ minOps: 40, maxOps: 70 }),
          fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 1, maxLength: 40 }),
          async (gen, batchSizes) => {
            // Each run is rolled back, so generated ids may repeat across runs and shrinking works.
            await inRolledBackTenant(app, gen.orgId, async (tx) => {
              await insertGeneratedFixtures(admin.db, tx, gen);
              const clock = clockFrom(gen.recordedAt);
              let batches = 0;
              for (let i = 0; i < gen.drafts.length; batches++) {
                const size = batchSizes[batches % batchSizes.length]!;
                await appendEvents(tx, gen.engagementId, gen.drafts.slice(i, i + size), { clock });
                i += size;
              }

              const events = await readEvents(tx, gen.engagementId);
              expect(events).toHaveLength(gen.drafts.length);
              const live = await dumpProjections(tx, gen.engagementId);
              expect(live).toEqual(projectRows(fold(events)));

              // The generator's own model agrees with the projected items (independent oracle).
              for (const [itemId, expected] of gen.expected) {
                const row = live.item.find((r) => r.id === itemId);
                expect(row).toMatchObject({
                  shortId: expected.shortId,
                  kind: expected.kind,
                  currentVersion: expected.currentVersion,
                  status: expected.status,
                  lifecycle: expected.lifecycle,
                  needsReview: expected.needsReview,
                });
                const deps = live.item_dependency.filter((d) => d.itemId === itemId).map((d) => d.dependsOnItemId);
                expect(deps.sort()).toEqual(expected.dependsOn);
              }

              // Damage the tables, then rebuild from the log.
              await tx.delete(item).where(eq(item.engagementId, gen.engagementId));
              await tx.delete(itemDependency).where(eq(itemDependency.engagementId, gen.engagementId));
              await tx.update(source).set({ charLength: 0, redactedAt: null }).where(eq(source.engagementId, gen.engagementId));
              await rebuildProjections(tx, gen.engagementId);
              expect(await dumpProjections(tx, gen.engagementId)).toEqual(live);
              expect((await verifyEngagementChain(tx, gen.engagementId)).ok).toBe(true);

              totalEvents += events.length;
              runs += 1;
            });
          },
        ),
        { numRuns: 24 },
      );
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`[projections property test] ${runs} runs, ${totalEvents} events appended and rebuilt in ${seconds}s`);
      expect(totalEvents).toBeGreaterThanOrEqual(MIN_TOTAL_EVENTS);
    },
    180_000,
  );
});
