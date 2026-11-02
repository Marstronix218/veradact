import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "export",
    include: ["src/**/*.test.ts"],
    // The 600-event PDF test renders dozens of pages.
    testTimeout: 30_000,
  },
});
