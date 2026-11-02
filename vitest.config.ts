import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Runs once per test run, for every project: resets + migrates veradact_test.
    globalSetup: ["./packages/db/src/test-global-setup.ts"],
    projects: [
      "packages/db",
      "packages/core",
      "packages/ingest",
      "packages/ai",
      "packages/export",
      "packages/email",
      "packages/seed",
      "apps/mcp",
      "apps/web",
    ],
  },
});
