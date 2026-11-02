// Phase 4: the replay screen (known / agreed at a past date, compare two dates, decision context)
// and the export screen (chain verification, spec and record downloads) on an engagement whose
// history was recorded in March 2026 with a fake clock (helpers/replay.ts).
import { readFile } from "node:fs/promises";
import { expect as baseExpect, test } from "@playwright/test";
import { loginAs } from "./helpers/auth";
import { closeAdminDb, createOrgWithAdmin } from "./helpers/db";
import { closeReplayDb, createReplayHistory } from "./helpers/replay";

// Replay folds the log on every request and the dev server may compile the route on first use.
const expect = baseExpect.configure({ timeout: 15_000 });

test.afterAll(async () => {
  await Promise.all([closeAdminDb(), closeReplayDb()]);
});

test("replay shows past statuses, the agreed view, a comparison and decision context; export verifies and downloads", async ({ page, playwright }) => {
  test.setTimeout(120_000);
  const org = await createOrgWithAdmin();
  const h = await createReplayHistory({ orgId: org.orgId, userId: org.admin.id });
  await loginAs(page, org.admin.email);
  const base = `/engagements/${h.engagementId}`;
  const row = (shortId: string) => page.locator(`[data-testid="replay-row"][data-short-id="${shortId}"]`);

  // Known view on Mar 3: everything pending (R1 was only confirmed on Mar 5).
  await page.goto(`${base}/replay`);
  await page.getByLabel("As of", { exact: true }).fill("2026-03-03");
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(page).toHaveURL(/as_of=2026-03-03/);
  await expect(page.getByTestId("replay-as-of")).toContainText("the end of Mar 3, 2026");
  await expect(page.getByTestId("replay-as-of")).toContainText("2026-03-04T04:59:59.999Z");
  await expect(page.getByTestId("replay-as-of")).toContainText("America/New_York");
  await expect(page.getByTestId("replay-head")).toContainText(/seq \d+ · [0-9a-f]{64}/);
  await expect(page.getByTestId("replay-row")).toHaveCount(4);
  await expect(row(h.ids.r1).getByTestId("replay-status")).toHaveText("Pending");
  await expect(row(h.ids.a1).getByTestId("replay-status")).toHaveText("Pending");

  // Mar 6: R1 and D1 confirmed, A1 disputed (D1 flagged for review).
  await page.getByLabel("As of", { exact: true }).fill("2026-03-06");
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(page).toHaveURL(/as_of=2026-03-06/);
  await expect(row(h.ids.r1).getByTestId("replay-status")).toHaveText("Confirmed");
  await expect(row(h.ids.d1).getByTestId("replay-status")).toHaveText("Confirmed");
  await expect(row(h.ids.a1).getByTestId("replay-status")).toHaveText("Disputed");
  await expect(row(h.ids.d1)).toContainText(`Needs review: ${h.ids.a1}`);
  await expect(row(h.ids.r1)).toContainText(h.statements.r1v1);

  // Filter by status at that time.
  await page.getByLabel("Status at that time").selectOption("confirmed");
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page.getByTestId("replay-row")).toHaveCount(2);
  await page.getByRole("link", { name: "Clear" }).click();
  await expect(page.getByTestId("replay-row")).toHaveCount(4);

  // Agreed toggle: only confirmed items, at the confirmed version.
  await page.getByRole("navigation", { name: "Replay view" }).getByRole("link", { name: "Agreed" }).click();
  await expect(page).toHaveURL(/view=agreed/);
  await expect(page).toHaveURL(/as_of=2026-03-06/);
  await expect(page.getByTestId("agreed-row")).toHaveCount(2);
  await expect(page.locator(`[data-testid="agreed-row"][data-short-id="${h.ids.r1}"]`)).toContainText("Ada Client");
  await expect(page.locator(`[data-testid="agreed-row"][data-short-id="${h.ids.a1}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-testid="agreed-row"][data-short-id="${h.ids.r2}"]`)).toHaveCount(0);
  await expect(page.getByTestId("previously-agreed-row")).toHaveCount(0);

  // After R1's revision (Mar 10) it is only "previously agreed".
  await page.getByLabel("As of", { exact: true }).fill("2026-03-11");
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(page).toHaveURL(/as_of=2026-03-11/);
  await expect(page.getByTestId("agreed-row")).toHaveCount(1);
  await expect(page.locator(`[data-testid="previously-agreed-row"][data-short-id="${h.ids.r1}"]`)).toContainText(h.statements.r1v2);

  // Compare Mar 3 → Mar 6, then Mar 6 → Mar 11.
  await page.getByRole("navigation", { name: "Replay view" }).getByRole("link", { name: "Compare" }).click();
  await page.getByLabel("From", { exact: true }).fill("2026-03-03");
  await page.getByLabel("To", { exact: true }).fill("2026-03-06");
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(page).toHaveURL(/from=2026-03-03/);
  await expect(page.getByTestId("diff-confirmed")).toContainText(h.ids.r1);
  await expect(page.getByTestId("diff-confirmed")).toContainText(h.ids.d1);
  await expect(page.getByTestId("diff-disputed")).toContainText(h.ids.a1);
  await expect(page.getByTestId("diff-added")).toContainText("(0)");
  await expect(page.getByTestId("diff-revised")).toContainText("(0)");
  await page.getByLabel("From", { exact: true }).fill("2026-03-06");
  await page.getByLabel("To", { exact: true }).fill("2026-03-11");
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(page).toHaveURL(/to=2026-03-11/);
  await expect(page.getByTestId("diff-revised")).toContainText(new RegExp(`${h.ids.r1}\\s*v1 → v2`));
  await expect(page.getByTestId("diff-revised").getByTestId("word-diff").locator("ins")).toHaveText("two");
  await expect(page.getByTestId("diff-confirmed")).toContainText("(0)");

  // Decision context of D1: A1 was pending when D1 was recorded.
  await page.goto(`${base}/items/${h.ids.d1}`);
  await page.getByRole("link", { name: "What did we know when this was decided?" }).click();
  await expect(page.getByTestId("decision-context")).toContainText(`${h.ids.d1} version 1 was decided?`);
  const dependency = page.locator(`[data-testid="context-dependency"][data-short-id="${h.ids.a1}"]`);
  await expect(dependency).toContainText("Carriers accept CSV uploads.");
  await expect(dependency).toContainText("Pending");
  await expect(page.getByTestId("decision-context").getByTestId("replay-row")).toHaveCount(4);

  // Export: live verification, spec download (D1 only confirmed now), record PDF.
  await page.goto(`${base}/export`);
  await expect(page.getByTestId("chain-status")).toContainText("Verified");
  await expect(page.getByTestId("spec-preview")).toContainText("## Not confirmed — do not build");

  const specDownload = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download spec.md" }).click();
  const spec = await specDownload;
  expect(spec.suggestedFilename()).toMatch(/^HALV-spec-\d{4}-\d{2}-\d{2}\.md$/);
  const specText = await readFile((await spec.path())!, "utf8");
  const [confirmedPart, notConfirmedPart] = specText.split("## Not confirmed — do not build");
  expect(confirmedPart).toContain(`### ${h.ids.d1} · ${h.statements.d1}`);
  expect(confirmedPart).not.toContain(`### ${h.ids.r1}`);
  expect(notConfirmedPart).toContain(`- ${h.ids.r1} · ${h.statements.r1v2}`);
  expect(notConfirmedPart).toContain(`- ${h.ids.a1} ·`);
  expect(notConfirmedPart).toContain(`- ${h.ids.r2} ·`);

  const pdfDownload = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download record (PDF)" }).click();
  const pdf = await pdfDownload;
  expect(pdf.suggestedFilename()).toMatch(/^HALV-record-\d{4}-\d{2}-\d{2}\.pdf$/);
  const pdfBytes = await readFile((await pdf.path())!);
  expect(pdfBytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");

  // A past-dated spec from the same route: on Mar 6 R1 was agreed at version 1.
  const pastSpec = await page.request.get(`/api/engagements/${h.engagementId}/export/spec.md?as_of=2026-03-06`);
  expect(pastSpec.status()).toBe(200);
  expect(await pastSpec.text()).toContain(`### ${h.ids.r1} · ${h.statements.r1v1}`);

  // The download routes need a session.
  const anonymous = await playwright.request.newContext({ baseURL: process.env.APP_URL ?? "http://localhost:3000" });
  expect((await anonymous.get(`/api/engagements/${h.engagementId}/export/record.md`)).status()).toBe(401);
  await anonymous.dispose();
});
