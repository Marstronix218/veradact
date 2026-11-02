// Phase 5 deletion flow (ARCHITECTURE §6): erasing a client contact and redacting a source on an
// engagement with a confirmed item. Erasure is admin only (D-057): a member sees why the button is
// disabled. Afterwards the item shows "Erased contact", the contact's link is dead (410), the hash
// chain still verifies on the export page, and a redacted source shows no quote text.
import { expect, test, type Browser } from "@playwright/test";
import { loginAs } from "./helpers/auth";
import { closeAdminDb, createOrgWithAdmin, createUser } from "./helpers/db";
import { closeLedgerDb, confirmFirstItem, createEngagementWithItems, createRequestLink } from "./helpers/ledger";

test.afterAll(async () => {
  await Promise.all([closeAdminDb(), closeLedgerDb()]);
});

async function signedIn(browser: Browser, email: string) {
  const page = await (await browser.newContext()).newPage();
  page.on("dialog", (dialog) => void dialog.accept());
  await loginAs(page, email);
  return page;
}

test("erasing a contact and redacting a source keep the record verifiable and show no personal data or quotes", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const org = await createOrgWithAdmin();
  const member = await createUser(org.orgId, "member");
  const fixture = await createEngagementWithItems({ orgId: org.orgId, userId: org.admin.id });
  const clientUrl = await createRequestLink({ orgId: org.orgId, userId: org.admin.id }, fixture);
  await confirmFirstItem({ orgId: org.orgId }, fixture, clientUrl);
  const base = `/engagements/${fixture.engagementId}`;
  const confirmed = fixture.items[0]!;
  const quote = "The dispatch board must refresh every five minutes.";

  // The link works before erasure.
  expect((await request.get(clientUrl)).status()).toBe(200);

  // A member cannot erase: the button is disabled and says why.
  const memberPage = await signedIn(browser, member.email);
  await memberPage.goto(`${base}/contacts`);
  await memberPage.getByText("Erase…").click();
  await expect(memberPage.getByText("Only an admin can erase a contact")).toBeVisible();
  await expect(memberPage.getByRole("button", { name: "Erase personal data" })).toBeDisabled();

  // The admin erases the contact from the Contacts page.
  const page = await signedIn(browser, org.admin.email);
  await page.goto(`${base}/items/${confirmed.shortId}`);
  await expect(page.getByText(fixture.contact.name).first()).toBeVisible();
  await page.goto(`${base}/contacts`);
  await page.getByText("Erase…").click();
  await page.getByLabel("I understand this cannot be undone.").check();
  await page.getByRole("button", { name: "Erase personal data" }).click();
  await expect(page.getByTestId("contact-row")).toContainText("Erased contact");
  await expect(page.getByTestId("contact-row")).not.toContainText(fixture.contact.name);
  await expect(page.getByTestId("contact-row")).not.toContainText(fixture.contact.email);

  // The item keeps the confirmation, attributed to "Erased contact".
  await page.goto(`${base}/items/${confirmed.shortId}`);
  await expect(page.getByText("Erased contact").first()).toBeVisible();
  await expect(page.getByText("Confirmed", { exact: true }).first()).toBeVisible();
  await expect(page.locator("main")).not.toContainText(fixture.contact.name);

  // The contact's link now shows the invalid-link page.
  const dead = await request.get(clientUrl);
  expect(dead.status()).toBe(410);
  expect(await dead.text()).toContain("This link is no longer valid");

  // The hash chain still verifies.
  await page.goto(`${base}/export`);
  await expect(page.getByTestId("chain-status")).toContainText("Verified", { timeout: 15_000 });

  // Redacting the source: the item shows the redaction date instead of the quote.
  await page.goto(`${base}/items/${confirmed.shortId}`);
  await expect(page.getByTestId("verified-quote").first()).toContainText(quote);
  await page.goto(`${base}/sources`);
  await page.getByRole("link", { name: "Kickoff notes" }).click();
  await page.getByLabel("I understand the text will be deleted permanently.").check();
  await page.getByRole("button", { name: "Redact source" }).click();
  await expect(page.getByText("The text of this source was redacted.", { exact: false })).toBeVisible();
  await page.goto(`${base}/items/${confirmed.shortId}`);
  await expect(page.getByText(/Source redacted on/).first()).toBeVisible();
  await expect(page.getByTestId("verified-quote")).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText(quote);

  // Redaction is in the log too, and the chain still verifies.
  await page.goto(`${base}/export`);
  await expect(page.getByTestId("chain-status")).toContainText("Verified", { timeout: 15_000 });
});
