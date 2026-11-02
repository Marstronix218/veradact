// The metrics scenario persisted through the real commands must give the scenario's known numbers
// (ARCHITECTURE §12, D-022, D-043), per engagement, per org and in the CSV.
import { afterAll, describe, expect, it } from "vitest";
import { withTenant } from "@veradact/db";
import { adminTestDb, testDb } from "@veradact/db/testing";
import { METRICS_SCENARIO_NOW } from "../domain/testing/metrics-scenario";
import { rebuildProjections, dumpProjections, verifyEngagementChain } from "../store";
import { createLedgerTenant } from "../test-support/ledger";
import { buildMetricsCsv, loadEngagementMetrics, loadOrgMetrics, seedMetricsScenario } from "./index";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

describe("metrics queries", () => {
  it("seedMetricsScenario + loadEngagementMetrics give a 60% five-business-day rate and the scenario's other numbers", async () => {
    const tenant = await createLedgerTenant(admin.db);
    const now = METRICS_SCENARIO_NOW;
    const seeded = await withTenant(app.db, { orgId: tenant.orgId }, (tx) => seedMetricsScenario(tx, { ...tenant, now }));

    await withTenant(app.db, { orgId: tenant.orgId }, async (tx) => {
      const metrics = await loadEngagementMetrics(tx, seeded.engagementId, now);
      expect(metrics).not.toBeNull();
      const { confirmDurationsMs, ...summary } = metrics!;
      expect(summary).toMatchObject(seeded.expected);
      expect(metrics!.confirmationRate).toBe(0.6);
      expect(metrics!.rateBand).toBe("on_target");
      expect(confirmDurationsMs).toHaveLength(8);
      expect(metrics).toMatchObject({ versionsMatured: 10, versionsMaturing: 3, versionsPulled: 1, medianHoursToConfirm: 4.5, linksSent: 8, linksInteracted: 4, openCount: 11, specExports: 3, mcpFetches: 4 });

      // The seed went through the real append path: the chain verifies and rebuild equals live.
      expect((await verifyEngagementChain(tx, seeded.engagementId)).ok).toBe(true);
      const live = await dumpProjections(tx, seeded.engagementId);
      await rebuildProjections(tx, seeded.engagementId);
      expect(await dumpProjections(tx, seeded.engagementId)).toEqual(live);

      const view = await loadOrgMetrics(tx, now);
      expect(view.engagements).toHaveLength(1);
      expect(view.org).toMatchObject({ engagementCount: 1, confirmationRate: 0.6, rateBand: "on_target", versionsMatured: 10, versionsConfirmedInWindow: 6 });

      // Earlier "now": fewer versions have matured.
      const earlier = await loadEngagementMetrics(tx, seeded.engagementId, new Date(now.getTime() - 7 * 86_400_000));
      expect(earlier!.versionsMatured).toBeLessThan(10);
      expect(await loadEngagementMetrics(tx, "00000000-0000-4000-8000-000000000000", now)).toBeNull();
    });
  });

  it("builds the CSV download with one engagement row and the org total", async () => {
    const tenant = await createLedgerTenant(admin.db);
    const now = METRICS_SCENARIO_NOW;
    const seeded = await withTenant(app.db, { orgId: tenant.orgId }, (tx) => seedMetricsScenario(tx, { ...tenant, now, shortCode: "CSV1" }));
    const csv = await withTenant(app.db, { orgId: tenant.orgId }, (tx) => buildMetricsCsv(tx, now));
    expect(csv.filename).toBe("veradact-metrics-2026-06-17.csv");
    const lines = csv.body.trimEnd().split("\r\n");
    expect(lines).toHaveLength(3);
    const header = lines[0]!.split(",");
    const cell = (line: string, column: string) => line.split(",")[header.indexOf(column)];
    expect(lines[1]!.startsWith(`engagement,${seeded.engagementId},CSV1,Halvorsen dispatch pilot,America/New_York,`)).toBe(true);
    expect(lines[2]!.startsWith("org,,,,,")).toBe(true);
    for (const line of [lines[1]!, lines[2]!]) {
      expect(cell(line, "confirmation_rate_5_business_days")).toBe("0.6000");
      expect(cell(line, "confirmation_rate_band")).toBe("on_target");
      expect(cell(line, "versions_matured")).toBe("10");
      expect(cell(line, "median_hours_to_confirm")).toBe("4.5");
      expect(cell(line, "mcp_fetches")).toBe("4");
    }
  });
});
