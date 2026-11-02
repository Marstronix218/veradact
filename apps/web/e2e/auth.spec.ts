import { expect, test } from "@playwright/test";
import { loginAs, requestMagicLink } from "./helpers/auth";
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

test("a magic link works only once", async ({ page, browser }) => {
  const { admin } = await createOrgWithAdmin();
  const link = await requestMagicLink(page, admin.email);
  await page.goto(link);
  await expect(page).toHaveURL(/\/engagements$/);

  const other = await browser.newContext();
  const replay = await other.newPage();
  await replay.goto(link);
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
