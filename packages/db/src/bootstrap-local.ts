// Prepares the local Supabase stack after `supabase start` (part of `pnpm db:up`, D-061): gives
// the app role a login with the password in DATABASE_URL and creates the test database. Local
// hosts only. A hosted project gets the role from migration 0000 and its password from ops
// (ARCHITECTURE §17).
//
//   tsx src/bootstrap-local.ts    DATABASE_ADMIN_URL, DATABASE_URL, TEST_DATABASE_ADMIN_URL (optional)
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { loadRootEnv, requireEnv } from "./env";
import { connectionHosts, isLocalDatabaseUrl } from "./local";
import { describeUrl } from "./migrate";

/** Migrations grant to this role by name. */
const APP_ROLE = "veradact_app";

export interface BootstrapUrls {
  adminUrl: string;
  appUrl: string;
  testAdminUrl?: string;
}

export async function bootstrapLocal(urls: BootstrapUrls): Promise<void> {
  for (const url of [urls.adminUrl, urls.appUrl, urls.testAdminUrl]) {
    if (url !== undefined && !isLocalDatabaseUrl(url)) {
      throw new Error(`refusing to bootstrap ${connectionHosts(url)?.join(",") ?? "(unparseable URL)"}: not a local database (hosted setup: ARCHITECTURE §17)`);
    }
  }
  const app = new URL(urls.appUrl);
  if (decodeURIComponent(app.username) !== APP_ROLE) throw new Error(`DATABASE_URL must connect as ${APP_ROLE}`);
  const password = decodeURIComponent(app.password);
  if (!password) throw new Error("DATABASE_URL has no password");
  const testDatabase = urls.testAdminUrl ? new URL(urls.testAdminUrl).pathname.slice(1) : null;
  if (testDatabase !== null && !testDatabase.endsWith("_test")) {
    throw new Error(`refusing to create "${testDatabase}": not a *_test database`);
  }

  const sql = postgres(urls.adminUrl, { max: 1, onnotice: () => {} });
  try {
    // Role statements take no bind parameters, so the password is inlined as a quoted literal.
    const passwordLiteral = `'${password.replaceAll("'", "''")}'`;
    const [role] = await sql<{ privileged: boolean }[]>`
      select rolsuper or rolbypassrls or rolcreatedb or rolcreaterole or rolreplication
             or pg_has_role(oid, 'pg_read_all_data', 'MEMBER') or pg_has_role(oid, 'pg_write_all_data', 'MEMBER') as privileged
        from pg_roles where rolname = ${APP_ROLE}`;
    // A non-superuser owner cannot reset these, so refuse instead of logging in a powerful role.
    if (role?.privileged) throw new Error(`${APP_ROLE} exists with elevated attributes; drop it and run db:up again`);
    await sql.unsafe(
      role
        ? `ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD ${passwordLiteral}`
        : `CREATE ROLE ${APP_ROLE} WITH LOGIN PASSWORD ${passwordLiteral} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    if (testDatabase !== null) {
      const [database] = await sql`select 1 from pg_database where datname = ${testDatabase}`;
      if (!database) await sql`create database ${sql(testDatabase)}`;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadRootEnv();
  const urls: BootstrapUrls = {
    adminUrl: requireEnv("DATABASE_ADMIN_URL"),
    appUrl: requireEnv("DATABASE_URL"),
    testAdminUrl: process.env.TEST_DATABASE_ADMIN_URL || undefined,
  };
  bootstrapLocal(urls)
    .then(() => console.log(`[@veradact/db] bootstrapped ${describeUrl(urls.adminUrl)}`))
    .catch((error: unknown) => {
      console.error("[@veradact/db] bootstrap failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
