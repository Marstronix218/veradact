// Drops and recreates the test database's schemas, then migrates. Refuses any database
// whose name does not end in `_test`.
//
//   tsx src/reset-test-db.ts    TEST_DATABASE_ADMIN_URL
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { loadRootEnv, requireEnv } from "./env";
import { describeUrl, runMigrations } from "./migrate";

export async function resetTestDatabase(adminUrl: string): Promise<void> {
  const database = new URL(adminUrl).pathname.slice(1);
  if (!database.endsWith("_test")) {
    throw new Error(`refusing to reset "${database}": not a *_test database`);
  }
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    // `drizzle` holds the migrator's bookkeeping; dropping public also drops citext.
    await sql.unsafe(`
      DROP SCHEMA IF EXISTS drizzle CASCADE;
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
    `);
    await runMigrations(adminUrl);
    // A recreated schema has no PUBLIC grants. Migration 0002 grants this too; repeating it
    // keeps the reset correct even if that migration changes.
    await sql.unsafe(`GRANT USAGE ON SCHEMA public TO veradact_app`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadRootEnv();
  const url = requireEnv("TEST_DATABASE_ADMIN_URL");
  resetTestDatabase(url)
    .then(() => console.log(`[@veradact/db] reset ${describeUrl(url)}`))
    .catch((error: unknown) => {
      console.error("[@veradact/db] reset failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
