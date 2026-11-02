import { chromium } from "@playwright/test";
import { loginAs } from "./helpers/auth";
import { clearRateLimits, closeAdminDb, createOrgWithAdmin } from "./helpers/db";
import { closeLedgerDb, createEngagementWithItems, createRequestLink } from "./helpers/ledger";

/**
 * Renders every screen once, signed in, before the tests start (Playwright starts the web server
 * before global setup). `next dev` compiles routes on first use, and a compile finishing while
 * another test's page is open can make Fast Refresh reload that page and swallow a click or a form
 * post; with everything compiled up front the run is deterministic.
 */
async function warmUp(baseURL: string): Promise<void> {
  const org = await createOrgWithAdmin();
  const fixture = await createEngagementWithItems({ orgId: org.orgId, userId: org.admin.id });
  const clientUrl = await createRequestLink({ orgId: org.orgId, userId: org.admin.id }, fixture);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ baseURL });
    await loginAs(page, org.admin.email);
    const e = `/engagements/${fixture.engagementId}`;
    for (const route of [
      "/engagements",
      "/engagements/new",
      e,
      `${e}/items/${fixture.items[0]!.shortId}`,
      `${e}/items/new`,
      `${e}/sources`,
      `${e}/sources/new`,
      `${e}/review`,
      `${e}/confirmations`,
      `${e}/contacts`,
      `${e}/settings`,
      `${e}/replay`,
      `${e}/replay?view=agreed`,
      `${e}/replay?view=compare`,
      `${e}/export`,
      "/metrics",
      "/notifications",
      "/settings",
      "/settings/users",
      "/settings/api-tokens",
      clientUrl,
    ]) {
      await page.goto(route, { waitUntil: "load", timeout: 90_000 });
    }
    // Source detail, by following the first source link.
    await page.goto(`${e}/sources`);
    await page.getByRole("link", { name: "Kickoff notes" }).click();
    await page.waitForURL(/\/sources\/[0-9a-f-]{36}$/, { timeout: 90_000 });
    // Route handlers and redirects the tests reach (a GET to the POST-only /logout compiles it too).
    for (const route of ["/", "/logout", "/api/metrics.csv", ...["spec.md", "record.md", "record.pdf"].map((f) => `/api/engagements/${fixture.engagementId}/export/${f}`)]) {
      await page.request.get(route, { maxRedirects: 0, timeout: 90_000 });
    }
  } finally {
    await browser.close();
  }
}

export default async function globalSetup(): Promise<void> {
  try {
    // Repeated local runs share one client IP; start each run with fresh rate-limit windows.
    await clearRateLimits();
    await warmUp(process.env.APP_URL ?? "http://localhost:3000");
  } finally {
    await Promise.all([closeAdminDb(), closeLedgerDb()]);
  }
}
