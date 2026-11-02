import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/db",
      "packages/core",
      "packages/ingest",
      "packages/ai",
      "packages/export",
      "packages/email",
      "apps/mcp",
      "apps/web",
    ],
  },
});
