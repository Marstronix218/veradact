// Phase 2 vendor flow: engagement → source upload with attestation → AI suggestions (fixture model
// client, MODEL_CLIENT=fixture) → review queue → ledger with verified quotes; the consent block;
// AI off → manual entry.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect as baseExpect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/auth";
import { closeAdminDb, createOrgWithAdmin } from "./helpers/db";

// Server actions here run extraction and fold the log; the dev server may also be compiling.
const expect = baseExpect.configure({ timeout: 15_000 });

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

test.afterAll(closeAdminDb);

// The dev server compiles a route on first use; a compile triggered by a server-action redirect can
// make Next's dev client reload the previous page. Compile the engagement routes up front.
test.beforeAll(async ({ request }) => {
  const base = "/engagements/00000000-0000-4000-8000-000000000000";
  for (const route of ["", "/review", "/sources", "/sources/new", "/items/new", "/items/X-R1", "/contacts", "/settings"]) {
    await request.get(`${base}${route}`, { maxRedirects: 0 });
  }
});

async function openSourceForm(page: Page, engagementUrl: string): Promise<void> {
  await page.goto(`${engagementUrl}/sources/new`);
  await expect(page.getByRole("heading", { name: "Add a source" })).toBeVisible();
}

async function attestAndSubmit(page: Page): Promise<void> {
  await page.getByLabel(/I confirm that the source type/).check();
  await page.getByRole("button", { name: "Add source" }).click();
}

test("sources, AI review queue, ledger, consent block, AI off and manual entry", async ({ page }) => {
  test.setTimeout(120_000);
  const { admin } = await createOrgWithAdmin();
  await loginAs(page, admin.email);

  // New engagement.
  await page.getByRole("link", { name: "New engagement" }).first().click();
  await page.getByLabel("Engagement name").fill("Dispatch assistant pilot");
  await page.getByLabel("Client name").fill("Halvorsen Freight");
  await page.getByLabel("Short code").fill("HALV");
  await page.getByRole("button", { name: "Create engagement" }).click();
  await expect(page).toHaveURL(/\/engagements\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("engagement-name")).toHaveText("Dispatch assistant pilot");
  await expect(page.getByText("AI on", { exact: true })).toBeVisible();
  const engagementUrl = page.url();

  // Human-written notes → two suggestions from the fixture model client.
  await openSourceForm(page, engagementUrl);
  await page.getByLabel("File", { exact: true }).setInputFiles(path.join(fixtures, "seed/02-security-review.md"));
  await page.getByLabel("Source type", { exact: true }).selectOption("human_notes");
  await page.getByLabel("Source date", { exact: true }).fill("2026-09-15");
  await attestAndSubmit(page);
  await expect(page).toHaveURL(/\/review\?run=/);
  await expect(page.getByTestId("run-summary")).toContainText("AI proposed 2 items: 2 added to the queue, 0 dropped");
  const candidates = page.getByTestId("candidate");
  await expect(candidates).toHaveCount(2);
  await expect(candidates.first()).toContainText("Exact quote");

  // Accept both.
  await candidates.filter({ hasText: "Only Halvorsen IT can approve new integrations" }).getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByTestId("accepted-notice")).toContainText("Accepted as HALV-C1");
  await expect(candidates).toHaveCount(1);
  await candidates.first().getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByTestId("accepted-notice")).toContainText("Accepted as HALV-R1");
  await expect(candidates).toHaveCount(0);

  // A second source with recorded (imperfect) model output → reject one suggestion.
  await openSourceForm(page, engagementUrl);
  await page.getByLabel("File", { exact: true }).setInputFiles(path.join(fixtures, "eval/e2-insurer-notes.md"));
  await page.getByLabel("Source date", { exact: true }).fill("2026-09-16");
  await attestAndSubmit(page);
  await expect(page).toHaveURL(/\/review\?run=/);
  await expect(page.getByTestId("run-summary")).toContainText("AI proposed 8 items: 8 added to the queue, 0 dropped because the quote was not found in the source, 1 with corrected");
  await expect(candidates).toHaveCount(8);
  await expect(page.getByText("Offset corrected")).toHaveCount(1);
  await candidates.first().getByRole("button", { name: "Reject" }).click();
  await expect(candidates).toHaveCount(7);

  // The ledger lists the two accepted items; the item page shows the verified quote.
  await page.getByRole("link", { name: "Ledger", exact: true }).click();
  await expect(page.getByTestId("ledger-row")).toHaveCount(2);
  await page.getByRole("link", { name: "HALV-C1", exact: true }).click();
  await expect(page.getByTestId("item-statement")).toContainText("Halvorsen IT");
  await expect(page.getByTestId("verified-quote")).toContainText("Only Halvorsen IT can approve new integrations");
  await expect(page.getByText("verified quote", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Suggested by AI (fixture, extract.v1), accepted as proposed")).toBeVisible();

  // Unattested machine transcript with a participant in California → blocked with the explanation.
  await openSourceForm(page, engagementUrl);
  await page.getByLabel("File", { exact: true }).setInputFiles(path.join(fixtures, "seed/03-scope-call.srt"));
  await expect(page.getByLabel("Source type", { exact: true })).toHaveValue("machine_transcript");
  await page.getByLabel("Title", { exact: true }).fill("Scope call");
  await page.getByLabel("Source date", { exact: true }).fill("2026-09-22");
  await page.getByLabel("Participant locations (US states)").selectOption(["CA", "TX"]);
  await expect(page.getByLabel("All participants consented to the recording")).not.toBeChecked();
  await attestAndSubmit(page);
  await expect(page.getByTestId("consent-explanation")).toContainText("California");
  await expect(page.getByTestId("consent-explanation")).toContainText("every party must consent");
  await expect(page).toHaveURL(/\/sources\/new$/);
  // The form keeps what was entered.
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Scope call");
  await expect(page.getByLabel("Source date", { exact: true })).toHaveValue("2026-09-22");

  // Engagement AI off → an upload lands on manual entry and produces no suggestions.
  await page.getByRole("link", { name: "Settings", exact: true }).last().click();
  await page.getByRole("button", { name: "Turn AI off" }).click();
  await expect(page.getByText("AI suggestions turned off.")).toBeVisible();
  await expect(page.getByText("AI off", { exact: true })).toBeVisible();

  await openSourceForm(page, engagementUrl);
  await page.getByLabel("Title", { exact: true }).fill("Weekly sync");
  await page.getByLabel("Or paste the text").fill("Weekly sync notes.\nDana: The pilot report goes out every Friday at noon.\n");
  await page.getByLabel("Source date", { exact: true }).fill("2026-09-29");
  await attestAndSubmit(page);
  await expect(page).toHaveURL(/\/items\/new\?source=[0-9a-f-]{36}&notice=ai_off$/);
  await expect(page.getByTestId("ai-off-notice")).toBeVisible();

  await page.goto(`${engagementUrl}/review`);
  await expect(candidates).toHaveCount(7);
  await expect(page.getByRole("row", { name: /Weekly sync/ })).toContainText("Never run");
  await expect(page.getByRole("row", { name: /Weekly sync/ }).getByRole("button", { name: "Re-run extraction" })).toBeDisabled();

  // A manual item without a source is "entered manually by" the member.
  await page.goto(`${engagementUrl}/items/new`);
  await page.getByLabel("Kind", { exact: true }).selectOption("decision");
  await page.getByLabel("Statement", { exact: true }).fill("The pilot report goes out every Friday at noon.");
  await page.getByRole("button", { name: "Add item" }).click();
  await expect(page).toHaveURL(/\/items\/HALV-D1\?created=1$/);
  await expect(page.getByTestId("manual-entry")).toHaveText("Entered manually by Erin Admin");
  await page.getByRole("link", { name: "Ledger", exact: true }).click();
  await expect(page.getByTestId("ledger-row")).toHaveCount(3);
});

test("item revision, dependencies, review flags, source highlights, redaction and contact erasure", async ({ page }) => {
  test.setTimeout(120_000);
  page.on("dialog", (dialog) => void dialog.accept());
  const { admin } = await createOrgWithAdmin();
  await loginAs(page, admin.email);
  await page.goto("/engagements/new");
  await page.getByLabel("Engagement name").fill("Billing revamp");
  await page.getByLabel("Client name").fill("Wexcombe Retail Group");
  await page.getByLabel("Short code").fill("wex");
  await page.getByLabel("Other time zone").fill("America/Halifax");
  await page.getByRole("button", { name: "Create engagement" }).click();
  await expect(page).toHaveURL(/\/engagements\/[0-9a-f-]{36}$/);
  await expect(page.getByText("WEX", { exact: true })).toBeVisible();
  const engagementUrl = page.url();

  // Pasted notes; the fixture client knows nothing about them.
  await openSourceForm(page, engagementUrl);
  await page.getByLabel("Title", { exact: true }).fill("Billing kickoff");
  await page.getByLabel("Or paste the text").fill("Billing kickoff.\nAmy: Invoices must be exported nightly to the ERP.\nRaj: We assume the ERP accepts CSV files.\n");
  await page.getByLabel("Source date", { exact: true }).fill("2026-10-01");
  await attestAndSubmit(page);
  await expect(page.getByTestId("run-summary")).toContainText("AI proposed 0 items");

  // Manual entry: an ambiguous quote asks for a longer one and keeps what was typed.
  await page.goto(`${engagementUrl}/items/new`);
  await page.getByLabel("Statement", { exact: true }).fill("Invoices are exported to the ERP every night.");
  await page.getByLabel("Source (optional)").selectOption({ label: "Billing kickoff · Oct 1, 2026" });
  await page.getByLabel("Exact quote").fill("ERP");
  await page.getByRole("button", { name: "Add item" }).click();
  await expect(page.getByText("That quote appears more than once in the source. Use a longer quote.")).toBeVisible();
  await expect(page.getByLabel("Statement", { exact: true })).toHaveValue("Invoices are exported to the ERP every night.");
  await page.getByLabel("Exact quote").fill("Invoices must be exported nightly to the ERP.");
  await page.getByRole("button", { name: "Add item" }).click();
  await expect(page).toHaveURL(/\/items\/WEX-R1\?created=1$/);
  await expect(page.getByTestId("verified-quote")).toContainText("Invoices must be exported nightly to the ERP.");
  await expect(page.getByTestId("verified-quote")).toContainText("Amy");

  await page.goto(`${engagementUrl}/items/new`);
  await page.getByLabel("Kind", { exact: true }).selectOption("assumption");
  await page.getByLabel("Statement", { exact: true }).fill("The ERP accepts CSV files.");
  await page.getByLabel("Source (optional)").selectOption({ label: "Billing kickoff · Oct 1, 2026" });
  await page.getByLabel("Exact quote").fill("We assume the ERP accepts CSV files.");
  await page.getByRole("button", { name: "Add item" }).click();
  await expect(page).toHaveURL(/\/items\/WEX-A1\?created=1$/);

  // Dependency, then a revision with a word diff.
  await page.goto(`${engagementUrl}/items/WEX-R1`);
  await page.getByLabel("Depends on", { exact: true }).selectOption({ label: "WEX-A1 · The ERP accepts CSV files." });
  await page.getByRole("button", { name: "Add dependency" }).click();
  await expect(page.getByText("Dependency added.")).toBeVisible();
  await expect(page.getByRole("row", { name: /WEX-A1 The ERP accepts CSV files/ })).toBeVisible();
  await page.getByLabel("Statement", { exact: true }).fill("Invoices are exported to the ERP every night by 02:00.");
  await page.locator("#revise-reason").selectOption("correction");
  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.getByText("Saved version 2.")).toBeVisible();
  const versions = page.getByTestId("version");
  await expect(versions).toHaveCount(2);
  await expect(versions.first().locator("ins")).toContainText("by 02:00.");
  await expect(versions.first()).toContainText("carried from the previous version");

  // Withdrawing the upstream assumption flags the requirement; clearing review removes the flag.
  await page.goto(`${engagementUrl}/items/WEX-A1`);
  await page.getByRole("button", { name: "Withdraw" }).click();
  await expect(page.getByText("Item withdrawn.")).toBeVisible();
  await page.goto(`${engagementUrl}?review=1&lifecycle=all`);
  await expect(page.getByTestId("ledger-row")).toHaveCount(1);
  await page.getByRole("link", { name: "WEX-R1", exact: true }).click();
  await expect(page.getByText(/Needs review:\s*WEX-A1 was withdrawn/)).toBeVisible();
  await page.getByRole("button", { name: "Clear review" }).click();
  await expect(page.getByText("Review cleared.")).toBeVisible();

  // The source page highlights cited quotes and links them to their items; redaction keeps citations.
  await page.getByRole("link", { name: "Sources", exact: true }).click();
  await expect(page).toHaveURL(/\/sources$/);
  await page.getByRole("link", { name: "Billing kickoff" }).click();
  await expect(page.getByTestId("source-text").locator("mark")).toHaveCount(2);
  await page.getByLabel("I understand the text will be deleted permanently.").check();
  await page.getByRole("button", { name: "Redact source" }).click();
  await expect(page.getByText("The text of this source was redacted.", { exact: false })).toBeVisible();
  await expect(page.getByTestId("source-text")).toHaveCount(0);
  await page.goto(`${engagementUrl}/items/WEX-R1`);
  await expect(page.getByText(/Source redacted on/).first()).toBeVisible();

  // Contacts: add, then erase with the strong confirmation.
  await page.getByRole("link", { name: "Contacts", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Gareth Pryce");
  await page.getByLabel("Email", { exact: true }).fill("gareth.pryce@wexcombe.example");
  await page.getByRole("button", { name: "Add contact" }).click();
  await expect(page.getByTestId("contact-row")).toContainText("Gareth Pryce");
  await page.getByText("Erase…").click();
  await page.getByLabel("I understand this cannot be undone.").check();
  await page.getByRole("button", { name: "Erase personal data" }).click();
  await expect(page.getByTestId("contact-row")).toContainText("Erased contact");
  await expect(page.getByTestId("contact-row")).not.toContainText("Gareth");

  // Engagement settings: rename (the header follows).
  await page.getByRole("link", { name: "Settings", exact: true }).last().click();
  await expect(page.getByLabel("Other time zone")).toHaveValue("America/Halifax");
  await page.getByLabel("Engagement name").fill("Billing revamp (phase 1)");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Engagement updated.")).toBeVisible();
  await expect(page.getByTestId("engagement-name")).toHaveText("Billing revamp (phase 1)");
});
