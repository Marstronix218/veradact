// Phase 3 acceptance (docs/SPEC.md): a member sends a request, the client opens the link,
// grants authorization, confirms two items and disputes one, the member sees the statuses, the
// member revises a confirmed item and it returns to pending without the old confirmation, and
// expired and revoked links are rejected. Plus the client page's other behaviours and phone layout.
import { devices, expect, test, type Browser, type Page } from "@playwright/test";
import { extractFirstLink, mailpitLatestTo } from "@veradact/email/mailpit";
import { loginAs } from "./helpers/auth";
import { closeAdminDb, createOrgWithAdmin } from "./helpers/db";
import { closeLedgerDb, createEngagementWithItems, createRequestLink, expireLinksOf, type LedgerFixture } from "./helpers/ledger";

test.afterAll(async () => {
  await Promise.all([closeAdminDb(), closeLedgerDb()]);
});

const CSP = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/** Sends the selected items from the Confirmations page and returns the client link from Mailpit. */
async function sendFromUi(page: Page, fixture: LedgerFixture, items: LedgerFixture["items"], expectedMessage: string): Promise<string> {
  await page.goto(`/engagements/${fixture.engagementId}/confirmations`);
  for (const item of items) await page.getByRole("checkbox", { name: new RegExp(item.shortId) }).check();
  await page.getByRole("checkbox", { name: new RegExp(fixture.contact.name) }).check();
  const sentAt = Date.now();
  await page.getByRole("button", { name: "Send request" }).click();
  await expect(page.getByText(expectedMessage)).toBeVisible();
  const message = await mailpitLatestTo(fixture.contact.email, { since: sentAt - 1000, timeoutMs: 15_000 });
  expect(message.subject).toContain(`asks you to confirm ${items.length === 1 ? "1 item" : `${items.length} items`}`);
  return extractFirstLink(message.text, "/c/");
}

async function clientPage(browser: Browser): Promise<Page> {
  // A fresh context: no vendor session cookie.
  const context = await browser.newContext();
  return context.newPage();
}

const group = (page: Page, shortId: string) => page.getByRole("group", { name: `Your response to ${shortId}` });

test("member sends a request; the client confirms two items and disputes one; revision, expiry and revocation", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const org = await createOrgWithAdmin();
  const fixture = await createEngagementWithItems({ orgId: org.orgId, userId: org.admin.id });
  const [first, second, third] = fixture.items as [LedgerFixture["items"][number], LedgerFixture["items"][number], LedgerFixture["items"][number]];
  await loginAs(page, org.admin.email);

  // 1. The member sends a request from the Confirmations page.
  const link = await sendFromUi(page, fixture, fixture.items, "3 items sent to 1 contact.");

  // 2. The client opens the link in a fresh browser context.
  const client = await clientPage(browser);
  const opened = await client.goto(link);
  expect(opened?.status()).toBe(200);
  expect(opened?.headers()["content-security-policy"]).toBe(CSP);
  expect(opened?.headers()["referrer-policy"]).toBe("no-referrer");
  expect(opened?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect(opened?.headers()["cache-control"]).toBe("no-store");
  expect(await client.locator("script").count()).toBe(0);
  await expect(client.getByRole("heading", { name: "Before you review: your authorization" })).toBeVisible();
  await expect(client.locator("#authorization-text")).toContainText("not used to train or fine-tune any AI model");

  // 3. Grants authorization.
  await client.getByRole("button", { name: "Grant authorization" }).click();
  await expect(client.getByRole("heading", { name: "Dispatch rollout" })).toBeVisible();
  await expect(client.getByText("“The dispatch board must refresh every five minutes.”")).toBeVisible();

  // 4. Confirms two items and disputes one with a comment, then submits.
  await group(client, first.shortId).getByRole("radio", { name: "Confirm" }).check();
  await group(client, second.shortId).getByRole("radio", { name: "Confirm" }).check();
  await group(client, third.shortId).getByRole("radio", { name: "Dispute" }).check();
  await group(client, third.shortId).getByRole("textbox", { name: /What is right instead/ }).fill("Our carriers only accept XML uploads.");
  await client.getByRole("button", { name: "Submit responses" }).click();

  // 5. Sees the receipt.
  await expect(client.getByRole("heading", { name: "Your responses were recorded" })).toBeVisible();
  for (const item of [first, second]) await expect(client.locator(`#receipt-${item.shortId}`)).toContainText("Confirmed");
  await expect(client.locator(`#receipt-${third.shortId}`)).toContainText("Disputed");
  await expect(client.locator(`#receipt-${first.shortId}`)).toContainText(first.contentHash);
  await expect(client.locator("#ledger-head")).toContainText(/[0-9a-f]{64}/);
  await expect(client.getByText("We have emailed a copy of this receipt to you.")).toBeVisible();

  // 6. The member sees the statuses and a dispute notification.
  await page.goto(`/engagements/${fixture.engagementId}/confirmations`);
  for (const item of [first, second]) await expect(page.getByTestId(`request-item-${item.shortId}`)).toContainText("Confirmed");
  await expect(page.getByTestId(`request-item-${third.shortId}`)).toContainText("Disputed");
  await expect(page.getByTestId("response-counts")).toHaveText("2 confirmed · 1 disputed · of 3");
  await expect(page.getByTestId("open-disputes")).toContainText("Our carriers only accept XML uploads.");
  await expect(page.getByRole("link", { name: "Notifications 1 unread" })).toBeVisible();
  await page.goto("/notifications");
  await expect(page.getByTestId("notification")).toContainText(`Ada Client disputed ${third.shortId} in Dispatch rollout.`);

  // 7. The member revises a confirmed item; it returns to pending and the old confirmation no longer counts.
  await page.goto(`/engagements/${fixture.engagementId}/items/${first.itemId}`);
  await page.getByLabel("Statement", { exact: true }).fill("The dispatch board refreshes every two minutes.");
  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.getByText("Saved version 2. It is pending until the client confirms it.")).toBeVisible();
  await page.goto(`/engagements/${fixture.engagementId}/confirmations`);
  const revisedRow = page.getByTestId(`request-item-${first.shortId}`);
  await expect(revisedRow).toContainText("Pending");
  await expect(revisedRow).toContainText("updated since this request (now v2)");
  await expect(page.getByTestId(`request-item-${second.shortId}`)).toContainText("Confirmed");
  // The new version can be sent again; the confirmed one cannot.
  await expect(page.getByRole("checkbox", { name: new RegExp(first.shortId) })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: new RegExp(second.shortId) })).toHaveCount(0);

  // 8. An expired link shows the invalid page with 410.
  await expireLinksOf(fixture.contact.contactId);
  const expired = await client.goto(link);
  expect(expired?.status()).toBe(410);
  await expect(client.getByRole("heading", { name: "This link is no longer valid" })).toBeVisible();

  // 9. A revoked link shows the same page with 410.
  const secondLink = await sendFromUi(page, fixture, [{ ...first, version: 2 }], "1 item sent to 1 contact.");
  expect((await client.goto(secondLink))?.status()).toBe(200);
  await expect(client.getByRole("heading", { name: "Dispatch rollout" })).toBeVisible();
  const newest = page.getByTestId("confirmation-request").first();
  page.once("dialog", (dialog) => dialog.accept());
  await newest.getByRole("button", { name: "Revoke link" }).click();
  // The row's revoke form is gone once the link is revoked; its status is the confirmation.
  await expect(newest.getByTestId("request-contact")).toContainText("Revoked");
  const revoked = await client.goto(secondLink);
  expect(revoked?.status()).toBe(410);
  await expect(client.getByRole("heading", { name: "This link is no longer valid" })).toBeVisible();
});

test("a dispute without a comment is rejected inline; Confirm all lists every item before confirming", async ({ browser }) => {
  const org = await createOrgWithAdmin();
  const fixture = await createEngagementWithItems({ orgId: org.orgId, userId: org.admin.id });
  const [first, second, third] = fixture.items as [LedgerFixture["items"][number], LedgerFixture["items"][number], LedgerFixture["items"][number]];
  const client = await clientPage(browser);
  await client.goto(await createRequestLink({ orgId: org.orgId, userId: org.admin.id }, fixture));
  await client.getByRole("button", { name: "Grant authorization" }).click();

  await group(client, first.shortId).getByRole("radio", { name: "Confirm" }).check();
  await group(client, second.shortId).getByRole("radio", { name: "Dispute" }).check();
  await client.getByRole("button", { name: "Submit responses" }).click();
  await expect(client.getByText("1 dispute needs a comment. Nothing was recorded yet.")).toBeVisible();
  await expect(group(client, second.shortId).getByText("Please say what is wrong")).toBeVisible();
  await expect(group(client, first.shortId).getByRole("radio", { name: "Confirm" })).toBeChecked();
  await expect(group(client, second.shortId).getByRole("radio", { name: "Dispute" })).toBeChecked();

  await client.getByRole("button", { name: /Confirm all 3 items/ }).click();
  await expect(client.getByRole("heading", { name: "Confirm all 3 items?" })).toBeVisible();
  const list = client.locator("#confirm-all-list li");
  await expect(list).toHaveCount(3);
  for (const item of [first, second, third]) await expect(client.locator("#confirm-all-list")).toContainText(item.statement);
  await client.getByRole("button", { name: "Confirm these 3 items" }).click();
  await expect(client.getByRole("heading", { name: "Your responses were recorded" })).toBeVisible();
  for (const item of [first, second, third]) await expect(client.locator(`#receipt-${item.shortId}`)).toContainText("Confirmed");

  // Going back shows the recorded responses preselected.
  await client.getByRole("link", { name: "Back to the items" }).click();
  await expect(group(client, third.shortId).getByRole("radio", { name: "Confirm" })).toBeChecked();
});

test("the client page fits a phone screen without horizontal scrolling", async ({ browser }) => {
  const org = await createOrgWithAdmin();
  const fixture = await createEngagementWithItems({ orgId: org.orgId, userId: org.admin.id });
  const url = await createRequestLink({ orgId: org.orgId, userId: org.admin.id }, fixture);
  const context = await browser.newContext({ ...devices["iPhone 13"] });
  const phone = await context.newPage();
  const overflow = () => phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  await phone.goto(url);
  await expect(phone.getByRole("button", { name: "Grant authorization" })).toBeVisible();
  expect(await overflow()).toBe(0);
  await phone.getByRole("button", { name: "Grant authorization" }).click();
  await expect(phone.getByRole("button", { name: "Submit responses" })).toBeVisible();
  expect(await overflow()).toBe(0);
  const box = await phone.getByRole("button", { name: "Submit responses" }).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);

  await phone.setViewportSize({ width: 320, height: 640 });
  expect(await overflow()).toBe(0);
  await context.close();
});

test("the client page refuses form posts from another site and oversized bodies", async ({ request }) => {
  const org = await createOrgWithAdmin();
  const fixture = await createEngagementWithItems({ orgId: org.orgId, userId: org.admin.id });
  const url = await createRequestLink({ orgId: org.orgId, userId: org.admin.id }, fixture);
  const crossSite = await request.post(url, { form: { action: "authorize", decision: "grant" }, headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example" }, maxRedirects: 0 });
  expect(crossSite.status()).toBe(403);
  const oversized = await request.post(url, { form: { action: "submit", pad: "x".repeat(300 * 1024) }, maxRedirects: 0 });
  expect(oversized.status()).toBe(413);
  // Nothing was recorded: the page still asks for authorization.
  const page = await request.get(url);
  expect(await page.text()).toContain("Grant");
});
