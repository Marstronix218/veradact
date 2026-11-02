import { defineConfig } from "vitest/config";

export default defineConfig({
  // `@/…` imports (tsconfig paths), as in the app.
  resolve: { tsconfigPaths: true },
  test: {
    // e2e/ is Playwright territory.
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
