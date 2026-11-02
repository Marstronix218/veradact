// `pnpm seed [--reset [--force]]`: seeds the fictional demo org (see demo.ts). `--reset` first
// purges the demo org — a dev-only escape hatch with its own guards (see reset.ts).
//
// The admin connection (DATABASE_ADMIN_URL) only creates the org and its users and runs the purge;
// everything else goes through the app role (DATABASE_URL), so RLS and triggers apply.
//
// Output: the demo users' emails and the admin's API token are printed once, on purpose — the
// data is synthetic and this is the operator's terminal, not a log (nothing here uses core/log).
// Errors are reported by SQLSTATE / fixed messages only, never with query parameters.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isCoreError } from "@veradact/core";
import { createDb, getPgError } from "@veradact/db";
import { DEMO_ENGAGEMENT, DEMO_ORG_NAME, DEMO_SLUG, DemoOrgExistsError, METRICS_ENGAGEMENT, seedDemo, type SeedDemoResult } from "./demo";
import { assertResetAllowed, databaseHost, purgeDemoOrg, ResetRefusedError, type PurgeResult } from "./reset";

const rootEnvPath = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath); // never overrides variables already set
// Commands log info lines (e.g. `confirmation.sent`); keep them out of the seed's own output.
process.env.LOG_LEVEL ??= "warn";

const MAILPIT_URL = "http://localhost:54332";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new UsageError(`${name} is not set (copy .env.example to .env)`);
  return value;
}

class UsageError extends Error {}

function printPurge(purged: PurgeResult): void {
  if (!purged.found) {
    console.log(`reset: no org with slug "${DEMO_SLUG}", nothing to purge`);
    return;
  }
  const total = Object.values(purged.deleted).reduce((a, b) => a + b, 0);
  const tables = Object.entries(purged.deleted)
    .map(([table, n]) => `${table} ${n}`)
    .join(", ");
  console.log(`reset: purged org ${purged.orgId} (${total} rows: ${tables})\n`);
}

function chainLine(chain: SeedDemoResult["chain"]): string {
  return chain.ok
    ? `ok (${chain.checked} events verified, head seq ${chain.headSeq} ${chain.headHash.slice(0, 16)}…)`
    : `FAILED at seq ${chain.firstBadSeq ?? "?"}: ${chain.reason ?? "unknown"}`;
}

function printResult(r: SeedDemoResult): void {
  const web = process.env.APP_URL ?? "http://localhost:3000";
  const mcp = process.env.MCP_PUBLIC_URL ?? "http://localhost:3001/mcp";
  const s = r.summary;
  console.log(
    [
      `Seeded ${DEMO_ORG_NAME} (slug ${r.slug}, org ${r.orgId})`,
      "",
      "Users",
      `  ${r.users.admin.email}   ${r.users.admin.name} (admin)`,
      `  ${r.users.member.email}   ${r.users.member.name} (member)`,
      `  Log in: open ${web}/login, enter one of these emails, then open the magic link`,
      `  that arrives in Mailpit at ${MAILPIT_URL}.`,
      "",
      `Engagement ${r.engagement.shortCode} · ${DEMO_ENGAGEMENT.name}`,
      `  items      ${s.total} (24 fixture entries; k19 is version 2 of k18)`,
      `  active     confirmed ${s.active.confirmed} · pending ${s.active.pending} · disputed ${s.active.disputed}`,
      `  lifecycle  superseded ${s.superseded} · withdrawn ${s.withdrawn}`,
      `  flags      needs review ${s.needsReview} · revised after confirmation ${s.revisedAfterConfirmation} · pending and never sent ${s.neverSent}`,
      `  chain      ${chainLine(r.chain)}`,
      "",
      `Engagement ${r.metrics.shortCode} · ${METRICS_ENGAGEMENT.name}`,
      `  chain      ${chainLine(r.metrics.chain)}`,
      "",
      `MCP API token for ${r.users.admin.email} (shown once, not stored):`,
      `  ${r.apiToken.token}`,
      "Connect Claude Code:",
      `  claude mcp add --transport http veradact ${mcp} --header "Authorization: Bearer ${r.apiToken.token}"`,
      "",
      "URLs",
      `  web app   ${web}`,
      `  Mailpit   ${MAILPIT_URL}`,
      `  MCP       ${mcp}`,
    ].join("\n"),
  );
}

function describeError(error: unknown): string {
  const pg = getPgError(error);
  if (pg) return `database error SQLSTATE ${pg.code}${pg.constraint ? ` (${pg.constraint})` : ""}`;
  if (isCoreError(error)) return `${error.name} ${error.code}: ${error.message}`;
  // Our own errors carry fixed messages; anything else (e.g. a driver error) by name only.
  if (error instanceof Error && error.name === "Error") return error.message;
  if (error instanceof Error) return `${error.name}${(error as { code?: unknown }).code ? ` ${String((error as { code?: unknown }).code)}` : ""}`;
  return "unknown error";
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { reset: { type: "boolean", default: false }, force: { type: "boolean", default: false } },
  });
  if (values.force && !values.reset) throw new UsageError("--force only applies to --reset");

  const adminUrl = requireEnv("DATABASE_ADMIN_URL");
  const admin = createDb(adminUrl, { max: 1 });
  const app = createDb(requireEnv("DATABASE_URL"), { max: 2 });
  try {
    if (values.reset) {
      const guard = { databaseUrl: adminUrl, nodeEnv: process.env.NODE_ENV, force: values.force };
      assertResetAllowed(guard); // purgeDemoOrg checks again; this only keeps the message below honest
      console.log(`reset: purging the demo org on ${databaseHost(adminUrl) ?? "?"} (dev-only escape hatch)`);
      printPurge(await purgeDemoOrg(admin.db, DEMO_SLUG, guard));
    }
    printResult(await seedDemo({ adminDb: admin.db, appDb: app.db }));
    return 0;
  } catch (error) {
    if (error instanceof DemoOrgExistsError) {
      console.error(`seed: the demo org already exists (slug "${error.slug}"). Run \`pnpm seed --reset\` to purge it and seed again.`);
      return 1;
    }
    if (error instanceof ResetRefusedError) {
      console.error(`seed: ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    await Promise.all([admin.close(), app.close()]);
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof UsageError ? `seed: ${error.message}` : `seed failed: ${describeError(error)}`);
    process.exit(1);
  },
);
