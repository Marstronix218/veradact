import { expect, test } from "@playwright/test";
import { extractFirstLink, mailpitLatestTo } from "@veradact/email/mailpit";
import { closeAdminDb, createOrgWithAdmin } from "./helpers/db";

test.afterAll(closeAdminDb);

async function requestSignupLink(page: import("@playwright/test").Page, email: string) {
  const requestedAt = Date.now();
  await page.goto("/login");
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(page).toHaveURL(/\/signup$/);
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-up link" }).click();
  await expect(page.getByText("Check your email")).toBeVisible();
  return mailpitLatestTo(email, { since: requestedAt - 500, timeoutMs: 15_000 });
}

test("signing up creates an org with you as admin and AI off, and signs you in", async ({ page, request }) => {
  const email = `signup-${Date.now()}@example.test`;
  const message = await requestSignupLink(page, email);
  expect(message.subject).toBe("Finish creating your Veradact account");
  const link = extractFirstLink(message.text, "/signup/complete");
  expect(link).not.toContain(email.split("@")[0]);

  // A mail scanner prefetching the link creates nothing.
  const prefetch = await request.get(link, { maxRedirects: 0 });
  expect(prefetch.status()).toBe(200);
  expect(prefetch.headers()["referrer-policy"]).toBe("strict-origin");

  await page.goto(link);
  await expect(page.getByText(`as ${email}`)).toBeVisible();
  await page.getByLabel("Organization name").fill("Fernwood Design");
  await page.getByLabel("Your name").fill("Ada Admin");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/engagements$/);
  await expect(page.getByTestId("current-user-email")).toHaveText(email);

  await page.goto("/settings");
  await expect(page.getByLabel(/AI/).first()).not.toBeChecked();

  // The link cannot make a second org.
  await page.context().clearCookies();
  await page.goto(link);
  await page.getByLabel("Organization name").fill("Second Org");
  await page.getByLabel("Your name").fill("Ada Admin");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/login\?error=exists$/);
  await expect(page.getByText("already has an account")).toBeVisible();
});

test("signing up works without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const email = `signup-nojs-${Date.now()}@example.test`;
  const message = await requestSignupLink(page, email);
  await page.goto(extractFirstLink(message.text, "/signup/complete"));
  await page.getByLabel("Organization name").fill("No Script Studio");
  await page.getByLabel("Your name").fill("Ada Admin");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/engagements$/);
  await expect(page.getByTestId("current-user-email")).toHaveText(email);
  await context.close();
});

test("an existing address gets the same answer and a pointer to sign in", async ({ page }) => {
  const { admin } = await createOrgWithAdmin();
  const message = await requestSignupLink(page, admin.email);
  expect(message.subject).toBe("You already have a Veradact account");
  expect(message.text).not.toContain("/signup/complete");
});

test("a forged sign-up link goes back to the sign-up page", async ({ page }) => {
  await page.goto(`/signup/complete?token=v1.${"A".repeat(60)}`);
  await expect(page).toHaveURL(/\/signup\?error=link$/);
  await expect(page.getByText("invalid or has expired")).toBeVisible();
});
