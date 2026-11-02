import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const webDir = path.dirname(fileURLToPath(import.meta.url));

// The e2e helpers need DATABASE_ADMIN_URL (fixtures) and the dev server needs the app env.
const rootEnv = path.resolve(webDir, "../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

// Must match APP_URL: magic links in emails point there.
const baseURL = process.env.APP_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  // The dev server compiles each route on its first request; under fully parallel workers a first
  // server-action round trip can take longer than Playwright's 5 s default.
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev",
    cwd: webDir,
    url: `${baseURL}/login`,
    // Real SMTP delivery into Mailpit, which the helpers read. Extraction uses the fixture model
    // client (fixtures/, no API key, nothing sent anywhere).
    env: { EMAIL_PROVIDER: "smtp", MODEL_CLIENT: "fixture" },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
