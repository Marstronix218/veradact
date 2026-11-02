// `pnpm db:cloud-setup`: one-command setup of a hosted Supabase project (ARCHITECTURE §17.1).
// Reads DATABASE_ADMIN_URL from the repo-root `.env.cloud`, then:
//   1. runs the migrations as postgres (TLS verified against Supabase's root CA);
//   2. gives veradact_app a login with a fresh random password, sent as a SCRAM verifier so the
//      plain text never reaches Supabase or its logs (running it again rotates the password);
//   3. writes the app's DATABASE_URL into `.env.cloud`;
//   4. connects as veradact_app and checks the lockdown.
// Prints hosts and checks only, never a password.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { createDb, tlsOptions } from "./client";
import { appUrlFromAdminUrl, removeEnvLine, scramSha256Verifier, setEnvLine } from "./cloud";
import { isLocalDatabaseUrl } from "./local";
import { describeUrl, runMigrations } from "./migrate";

const envPath = fileURLToPath(new URL("../../../.env.cloud", import.meta.url));

function fail(message: string): never {
  console.error(`db:cloud-setup: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (!existsSync(envPath)) fail(".env.cloud not found in the repo root");
  // Only .env.cloud: the root .env points at the local stack.
  process.loadEnvFile(envPath);
  const adminUrl = process.env.DATABASE_ADMIN_URL?.trim() ?? "";
  if (!adminUrl || adminUrl.includes("<")) fail("fill in <db-password> and <pooler-host> in DATABASE_ADMIN_URL in .env.cloud");
  try {
    new URL(adminUrl);
  } catch {
    fail("DATABASE_ADMIN_URL is not a valid URL; percent-encode any of @ : / ? # % & in the password");
  }
  if (isLocalDatabaseUrl(adminUrl)) fail("DATABASE_ADMIN_URL points at this machine; this script is for the hosted project");

  let env = readFileSync(envPath, "utf8");
  const caFile = process.env.DATABASE_CA_CERT_FILE?.trim();
  if (caFile && !existsSync(caFile)) {
    // Not needed for Supabase: the root CA is built in (supabase-ca.ts).
    delete process.env.DATABASE_CA_CERT_FILE;
    env = removeEnvLine(env, "DATABASE_CA_CERT_FILE");
  }
  if (!tlsOptions(adminUrl)) fail("DATABASE_ADMIN_URL is not a *.supabase.com / *.supabase.co host");

  console.log(`1/4 migrating ${describeUrl(adminUrl)}`);
  await runMigrations(adminUrl);

  console.log("2/4 setting the veradact_app password");
  const appPassword = randomBytes(32).toString("hex");
  const admin = postgres(adminUrl, { max: 1, ssl: tlsOptions(adminUrl), onnotice: () => {} });
  try {
    const [role] = await admin<{ privileged: boolean }[]>`
      select rolsuper or rolbypassrls or rolcreatedb or rolcreaterole or rolreplication as privileged
        from pg_roles where rolname = 'veradact_app'`;
    if (!role) fail("veradact_app does not exist after migrating");
    if (role.privileged) fail("veradact_app has elevated attributes; fix the role before giving it a login");
    await admin.unsafe(`ALTER ROLE veradact_app WITH LOGIN PASSWORD '${scramSha256Verifier(appPassword)}'`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  console.log("3/4 writing DATABASE_URL to .env.cloud");
  const appUrl = appUrlFromAdminUrl(adminUrl, appPassword);
  writeFileSync(envPath, setEnvLine(env, "DATABASE_URL", appUrl), { mode: 0o600 });

  console.log("4/4 checking the app login");
  // The pooler may take a moment to see the new password.
  let lastError: unknown;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const app = createDb(appUrl, { max: 1 });
    try {
      const [check] = await app.sql<{ user: string; rls: boolean; anon: boolean }[]>`
        select current_user as user,
               (select bool_and(relrowsecurity) from pg_class
                 where relnamespace = 'public'::regnamespace and relkind = 'r') as rls,
               has_schema_privilege('anon', 'public', 'USAGE') as anon`;
      if (check?.user !== "veradact_app" || !check.rls || check.anon) fail(`unexpected state: ${JSON.stringify(check)}`);
      console.log("done: migrations applied, app login works, RLS on every table, anon locked out.");
      console.log("next: set -a; source .env.cloud; set +a   then   pnpm seed (optional)   and   pnpm dev");
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    } finally {
      await app.close();
    }
  }
  fail(`the app login did not work: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
