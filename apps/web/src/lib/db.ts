// One postgres.js pool per server process, reused across dev HMR reloads. App role only
// (DATABASE_URL, RLS enforced); every tenant query goes through `withTenant` (see session.ts).
import { createDb, type Db, type DbHandle } from "@veradact/db";
import { requireEnv } from "./env";

const globalForDb = globalThis as typeof globalThis & { __veradactDb?: DbHandle };

export function getDb(): Db {
  globalForDb.__veradactDb ??= createDb(requireEnv("DATABASE_URL"), { max: 10 });
  return globalForDb.__veradactDb.db;
}
