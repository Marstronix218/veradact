import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "email",
    include: ["src/**/*.test.ts"],
    // *.int.test.ts waits on a real SMTP round trip through Mailpit.
    testTimeout: 20_000,
  },
});
