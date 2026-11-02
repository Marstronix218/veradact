import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "seed",
    include: ["src/**/*.test.ts"],
    // The integration test runs the whole demo seed (about 100 commands) twice.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
