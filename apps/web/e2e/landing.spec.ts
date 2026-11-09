import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers/auth";
import { closeAdminDb, createOrgWithAdmin } from "./helpers/db";

test.afterAll(closeAdminDb);

test("signed out, / shows the landing page, which links to sign in and sign up", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1, name: "Approvals that stick." })).toBeVisible();

  await page.getByRole("main").getByRole("link", { name: "Create an account" }).first().click();
  await expect(page).toHaveURL(/\/signup$/);

  await page.getByRole("link", { name: "Veradact" }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole("main").getByRole("link", { name: "Sign in" }).first().click();
  await expect(page).toHaveURL(/\/login$/);
});

test("signed in, / opens the engagements page", async ({ page }) => {
  const { admin } = await createOrgWithAdmin();
  await loginAs(page, admin.email);

  await page.goto("/");
  await expect(page).toHaveURL(/\/engagements$/);
});
