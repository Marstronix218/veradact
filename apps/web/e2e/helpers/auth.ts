import { expect, type Page } from "@playwright/test";
import { extractFirstLink, mailpitLatestTo } from "@veradact/email/mailpit";

/**
 * Submits the login form for `email` and returns the magic link from the email Mailpit
 * received (the dev server must run with EMAIL_PROVIDER=smtp).
 */
export async function requestMagicLink(page: Page, email: string): Promise<string> {
  const requestedAt = Date.now();
  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByText("Check your email")).toBeVisible();
  // Ignore earlier links to the same address (small allowance for clock skew with Mailpit).
  const message = await mailpitLatestTo(email, { since: requestedAt - 500, timeoutMs: 15_000 });
  return extractFirstLink(message.text, "/auth/verify");
}

/** Signs `page` in as `email` via a real magic link and waits for the engagements page. */
export async function loginAs(page: Page, email: string): Promise<void> {
  const link = await requestMagicLink(page, email);
  await page.goto(link);
  await expect(page).toHaveURL(/\/engagements$/);
}
