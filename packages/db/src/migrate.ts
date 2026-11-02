// Applies the migrations in packages/db/migrations through the Drizzle migrator (in order,
// one transaction). Admin URLs only: migrations create roles, policies and functions.
//
//   tsx src/migrate.ts          DATABASE_ADMIN_URL
//   tsx src/migrate.ts --test   TEST_DATABASE_ADMIN_URL
//   tsx src/migrate.ts --all    both
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { tlsOptions } from "./client";
import { loadRootEnv, requireEnv } from "./env";

export const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

export async function runMigrations(adminUrl: string): Promise<void> {
  const sql = postgres(adminUrl, { max: 1, ssl: tlsOptions(adminUrl), onnotice: () => {} });
  try {
    await migrate(drizzle({ client: sql }), { migrationsFolder });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** host:port/database, without credentials. */
export function describeUrl(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { test: { type: "boolean" }, all: { type: "boolean" } },
  });
  loadRootEnv();
  const names = values.all
    ? ["DATABASE_ADMIN_URL", "TEST_DATABASE_ADMIN_URL"]
    : [values.test ? "TEST_DATABASE_ADMIN_URL" : "DATABASE_ADMIN_URL"];
  for (const name of names) {
    const url = requireEnv(name);
    await runMigrations(url);
    console.log(`[@veradact/db] migrated ${describeUrl(url)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error("[@veradact/db] migration failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
