import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "core",
    include: ["src/**/*.test.ts"],
    // *.int.test.ts run many command transactions against the shared test database; under a full
    // parallel run (every project at once) a few of them approach Vitest's 5 s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
