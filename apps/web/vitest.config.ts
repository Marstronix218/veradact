import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // e2e/ is Playwright territory.
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
