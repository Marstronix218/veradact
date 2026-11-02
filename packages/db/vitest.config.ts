import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "db",
    include: ["src/**/*.test.ts"],
    // *.int.test.ts talk to the shared test database; leave headroom under a full parallel run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
