import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "mcp",
    include: ["src/**/*.test.ts"],
    // Each integration test builds an engagement through the commands and talks HTTP to the server.
    testTimeout: 30_000,
  },
});
