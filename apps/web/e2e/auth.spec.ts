import { expect, test } from "@playwright/test";
import { loginAs, openMagicLink, requestMagicLink } from "./helpers/auth";
import { closeAdminDb, createOrgWithAdmin } from "./helpers/db";

test.afterAll(closeAdminDb);

test("signing in with a magic link opens the engagements page", async ({ page }) => {
  const { admin } = await createOrgWithAdmin();
  await loginAs(page, admin.email);

  await expect(page.getByRole("heading", { name: "Engagements", exact: true })).toBeVisible();
  await expect(page.getByText("No engagements yet")).toBeVisible();
  await expect(page.getByTestId("current-user-email")).toHaveText(admin.email);

  const cookie = (await page.context().cookies()).find((c) => c.name === "vd_session");
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
  expect(cookie?.expires).toBeGreaterThan(Date.now() / 1000 + 29 * 24 * 3600);
});

test("protected pages redirect to the login page when signed out", async ({ page }) => {
  for (const path of ["/", "/engagements", "/settings", "/settings/users", "/settings/api-tokens", "/metrics"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
  }
});

test("an unknown address gets the same answer as a known one", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Work email").fill(`nobody-${Date.now()}@example.test`);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByText("Check your email")).toBeVisible();
});

test("opening a magic link does not use it up; only the sign-in button does", async ({ page, request }) => {
  const { admin } = await createOrgWithAdmin();
  const link = await requestMagicLink(page, admin.email);

  // A mail scanner prefetching the link (twice) gets the interstitial and burns nothing.
  for (let i = 0; i < 2; i += 1) {
    const prefetch = await request.get(link, { maxRedirects: 0 });
    expect(prefetch.status()).toBe(200);
    expect(prefetch.headers()["referrer-policy"]).toBe("no-referrer");
    expect(prefetch.headers()["x-robots-tag"]).toBe("noindex, nofollow");
    expect(prefetch.headers()["cache-control"]).toBe("no-store");
    expect(await prefetch.text()).toContain("Sign in to Veradact");
  }
  expect((await page.context().cookies()).find((c) => c.name === "vd_session")).toBeUndefined();

  await openMagicLink(page, link);
  await expect(page).toHaveURL(/\/engagements$/);
});

test("a sign-in form posted from another origin is rejected", async ({ page, request }) => {
  const { admin } = await createOrgWithAdmin();
  const link = await requestMagicLink(page, admin.email);
  const token = new URL(link).searchParams.get("token")!;
  const forged = await request.post("/auth/verify", { form: { token }, headers: { origin: "https://evil.example" }, maxRedirects: 0 });
  expect(forged.status()).toBe(303);
  expect(forged.headers()["location"]).toMatch(/\/login\?error=link$/);
  const crossSite = await request.post("/auth/verify", { form: { token }, headers: { origin: "null", "sec-fetch-site": "cross-site" }, maxRedirects: 0 });
  expect(crossSite.headers()["location"]).toMatch(/\/login\?error=link$/);
  // An opaque origin without Fetch Metadata (older browsers, sandboxed frames) is refused too.
  const opaque = await request.post("/auth/verify", { form: { token }, headers: { origin: "null" }, maxRedirects: 0 });
  expect(opaque.headers()["location"]).toMatch(/\/login\?error=link$/);
  // The token was not consumed.
  await openMagicLink(page, link);
  await expect(page).toHaveURL(/\/engagements$/);
});

test("a magic link works only once", async ({ page, browser }) => {
  const { admin } = await createOrgWithAdmin();
  const link = await requestMagicLink(page, admin.email);
  await openMagicLink(page, link);
  await expect(page).toHaveURL(/\/engagements$/);

  const other = await browser.newContext();
  const replay = await other.newPage();
  await openMagicLink(replay, link);
  await expect(replay).toHaveURL(/\/login\?error=link$/);
  await expect(replay.getByText("invalid, has expired or was already used")).toBeVisible();
  expect((await other.cookies()).find((c) => c.name === "vd_session")).toBeUndefined();
  await other.close();
});

test("logging out ends the session", async ({ page }) => {
  const { admin } = await createOrgWithAdmin();
  await loginAs(page, admin.email);

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.context().cookies()).find((c) => c.name === "vd_session")).toBeUndefined();

  await page.goto("/engagements");
  await expect(page).toHaveURL(/\/login$/);
});
