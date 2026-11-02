// Phase 3 acceptance: the metrics page shows the correct 5-business-day rate on seeded data.
import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers/auth";
import { closeAdminDb, createOrgWithAdmin } from "./helpers/db";
import { closeLedgerDb, seedMetricsOrg } from "./helpers/ledger";

test.afterAll(async () => {
  await Promise.all([closeAdminDb(), closeLedgerDb()]);
});

test("the metrics page shows the seeded 60% five-business-day rate as on target, with a CSV download", async ({ page, playwright }) => {
  const org = await createOrgWithAdmin();
  const seeded = await seedMetricsOrg({ orgId: org.orgId, userId: org.admin.id }, new Date());
  expect(seeded.expected.confirmationRate).toBe(0.6);
  await loginAs(page, org.admin.email);

  await page.goto("/metrics");
  const rate = page.getByTestId("confirmation-rate");
  await expect(rate).toContainText("60%");
  await expect(rate).toContainText("On target");
  await expect(rate).toContainText("6 of 10 matured item versions");
  const row = page.getByTestId(`metrics-row-${seeded.shortCode}`);
  await expect(row).toContainText("60%");
  await expect(row).toContainText("10 / 3 / 1");
  await expect(row).toContainText("4.5 h");

  // The engagement's confirmations page has the same rate in its metrics card.
  await row.getByRole("link", { name: "Halvorsen dispatch pilot" }).click();
  await expect(page.getByTestId("engagement-confirmation-rate")).toHaveText("60%");

  const csv = await page.request.get("/api/metrics.csv");
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  const body = await csv.text();
  expect(body).toContain(`engagement,${seeded.engagementId},PILOT,Halvorsen dispatch pilot,America/New_York,14,10,3,1,6,0.6000,on_target,4.5,`);

  const anonymous = await playwright.request.newContext({ baseURL: process.env.APP_URL ?? "http://localhost:3000" });
  expect((await anonymous.get("/api/metrics.csv")).status()).toBe(401);
  await anonymous.dispose();
});
