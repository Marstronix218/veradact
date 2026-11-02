// Root Vitest globalSetup (wired in /vitest.config.ts): once per test run, reset and
// migrate veradact_test. No-op when TEST_DATABASE_ADMIN_URL is unset.
//
// Separate runs (two terminals, two agents) share one test database. A run holds a shared
// advisory lock until it ends; a reset needs the exclusive lock, so it waits for running
// suites instead of dropping the schema under them.
import postgres from "postgres";
import { loadRootEnv } from "./env";
import { resetTestDatabase } from "./reset-test-db";

const TEST_RUN_LOCK = 4_242_017_001;

export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  loadRootEnv();
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  if (!adminUrl) return undefined;

  // Dedicated session for the lock; no lifetime limit, or the lock would drop mid-run.
  const lock = postgres(adminUrl, { max: 1, max_lifetime: null, idle_timeout: null, onnotice: () => {} });
  const [attempt] = await lock<{ ok: boolean }[]>`select pg_try_advisory_lock(${TEST_RUN_LOCK}::int8) as ok`;
  if (!attempt?.ok) {
    console.log("[@veradact/db] waiting for another test run on the test database to finish");
    await lock`select pg_advisory_lock(${TEST_RUN_LOCK}::int8)`;
  }
  try {
    await resetTestDatabase(adminUrl);
    await lock`select pg_advisory_lock_shared(${TEST_RUN_LOCK}::int8)`;
    await lock`select pg_advisory_unlock(${TEST_RUN_LOCK}::int8)`;
  } catch (error) {
    await lock.end({ timeout: 5 });
    throw error;
  }

  return async () => {
    await lock.end({ timeout: 5 });
  };
}
