import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers/auth";
import { closeAdminDb, createOrgWithAdmin, createUser } from "./helpers/db";

test.afterAll(closeAdminDb);

test("vendor pages send the security headers", async ({ page }) => {
  const response = await page.goto("/login");
  const headers = response?.headers() ?? {};
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
});

test("an admin changes org settings", async ({ page }) => {
  const { admin } = await createOrgWithAdmin();
  await loginAs(page, admin.email);
  await page.goto("/settings");

  const ai = page.getByLabel("Use AI to suggest items from sources");
  await expect(ai).toBeChecked();
  await ai.uncheck();
  await page.getByLabel("Delete source text after (days)").fill("90");
  await page.getByLabel("All-party consent states").fill("wa, ca");
  await page.getByRole("button", { name: "Save settings" }).click();
  // Saving runs a server action that writes settings and audit rows; allow for a cold route.
  await expect(page.getByText("Settings saved.")).toBeVisible({ timeout: 20_000 });

  await page.reload();
  await expect(page.getByLabel("Use AI to suggest items from sources")).not.toBeChecked();
  await expect(page.getByLabel("Delete source text after (days)")).toHaveValue("90");
  await expect(page.getByLabel("All-party consent states")).toHaveValue("CA, WA");

  await page.getByLabel("All-party consent states").fill("ZZ");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("must be two-letter US state codes")).toBeVisible();
});

test("a member sees settings read-only", async ({ page }) => {
  const { orgId } = await createOrgWithAdmin();
  const member = await createUser(orgId, "member");
  await loginAs(page, member.email);
  await page.goto("/settings");
  await expect(page.getByText("Only admins can change organization settings.")).toBeVisible();
  await expect(page.getByLabel("Use AI to suggest items from sources")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save settings" })).toHaveCount(0);

  await page.goto("/settings/users");
  await expect(page.getByText("Only admins can add or deactivate users.")).toBeVisible();
});

test("an admin adds and deactivates a user", async ({ page }) => {
  const { admin } = await createOrgWithAdmin();
  await loginAs(page, admin.email);
  await page.goto("/settings/users");

  const email = `e2e-invitee-${Date.now()}@example.test`;
  await page.getByLabel("Name").fill("Ivy Invitee");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Add user" }).click();
  await expect(page.getByText(`Added ${email}.`)).toBeVisible();

  const row = page.getByRole("row", { name: /Ivy Invitee/ });
  await expect(row.getByText("Active")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "Deactivate" }).click();
  await expect(page.getByRole("row", { name: /Deactivated user/ }).getByText("Deactivated", { exact: true })).toBeVisible();
});

test("a user creates, sees once and revokes an API token", async ({ page, baseURL }) => {
  const { admin } = await createOrgWithAdmin();
  await loginAs(page, admin.email);
  await page.goto("/settings/api-tokens");
  await expect(page.getByText("No API tokens")).toBeVisible();

  await page.getByLabel("Token name").fill("Claude Code");
  await page.getByRole("button", { name: "Create token" }).click();
  const created = page.getByTestId("new-api-token");
  await expect(created).toContainText("won't be shown again");
  await expect(page.getByLabel("New API token")).toHaveValue(/^vdt_[A-Za-z0-9_-]{43}$/);
  await expect(created).toContainText(process.env.MCP_PUBLIC_URL?.trim() || `${baseURL}/mcp`);

  const row = page.getByRole("row", { name: /Claude Code/ });
  await expect(row.getByText("Active")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(row.getByText("Revoked")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("new-api-token")).toHaveCount(0);
});

test("an API token works at the web app's /mcp until it is revoked", async ({ page, request }) => {
  const { admin } = await createOrgWithAdmin();
  await loginAs(page, admin.email);
  await page.goto("/settings/api-tokens");
  await page.getByLabel("Token name").fill("Agent");
  await page.getByRole("button", { name: "Create token" }).click();
  const token = await page.getByLabel("New API token").inputValue();

  const mcp = (method: string, params: Record<string, unknown> = {}) =>
    request.post("/mcp", {
      headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
      data: { jsonrpc: "2.0", id: 1, method, params },
    });
  const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  expect(init.status()).toBe(200);
  expect((await init.json()).result.serverInfo.name).toBe("veradact");
  const tools = await mcp("tools/list");
  expect(((await tools.json()).result.tools as { name: string }[]).map((t) => t.name).sort()).toEqual([
    "get_confirmed_spec",
    "get_item",
    "list_engagements",
    "list_unconfirmed",
  ]);
  expect((await request.get("/mcp")).status()).toBe(405);

  const row = page.getByRole("row", { name: /Agent/ });
  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(row.getByText("Revoked")).toBeVisible();
  const revoked = await mcp("tools/list");
  expect(revoked.status()).toBe(401);
  expect(revoked.headers()["www-authenticate"]).toBe('Bearer realm="veradact", error="invalid_token"');
});
