import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    // Owner role: migrations only. The app uses DATABASE_URL (RLS enforced).
    url: process.env.DATABASE_ADMIN_URL ?? "",
  },
});
