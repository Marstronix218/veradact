// `pnpm seed --reset`: purges the demo org so the seed can run again.
//
// ┌──────────────────────────────────────────────────────────────────────────────────────────┐
// │ DEV-ONLY ESCAPE HATCH. This is the only code in the repository that deletes event rows.   │
// │ The log is append-only by privilege AND by trigger (CLAUDE.md invariant 1); the purge     │
// │ gets past the triggers by running, as the database owner, inside ONE transaction with     │
// │ `SET LOCAL session_replication_role = replica`, which skips ordinary triggers (and FK     │
// │ checks) for that transaction only. It deletes every row of ONE org, found by slug, from   │
// │ every table that has an `org_id` column, then the org itself — nothing else.              │
// │                                                                                          │
// │ It refuses to run when NODE_ENV=production and against hosted Supabase (no override), and │
// │ against any other non-local database host unless `--force` is given. Never call it from  │
// │ app code, jobs or migrations, and never point it at a database whose history matters.     │
// └──────────────────────────────────────────────────────────────────────────────────────────┘
import { sql } from "drizzle-orm";
import { connectionHosts, getPgError, isLocalDatabaseUrl, type Db } from "@veradact/db";

/** Hosted Supabase lets its postgres role skip triggers too, so --force never reaches it (D-061). */
const SUPABASE_HOSTED = /\.supabase\.(co|com)\.?$/;

export interface ResetGuardInput {
  /** The admin connection string the purge will run on. */
  databaseUrl: string;
  /** `process.env.NODE_ENV`. */
  nodeEnv: string | undefined;
  /** `--force`: allow a non-local database host. Never overrides NODE_ENV=production. */
  force?: boolean;
}

export class ResetRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResetRefusedError";
  }
}

/** The host(s) the connection string really connects to (`?host=` included), or null when it cannot be parsed. */
export function databaseHost(databaseUrl: string): string | null {
  return connectionHosts(databaseUrl)?.join(",") ?? null;
}

/** Throws `ResetRefusedError` unless the purge is allowed (see the banner above). */
export function assertResetAllowed(input: ResetGuardInput): void {
  if (input.nodeEnv?.trim().toLowerCase() === "production") {
    throw new ResetRefusedError("refusing to purge: NODE_ENV is production (the reset is a dev-only escape hatch; --force does not override this)");
  }
  const host = databaseHost(input.databaseUrl);
  if (connectionHosts(input.databaseUrl)?.some((h) => SUPABASE_HOSTED.test(h))) {
    throw new ResetRefusedError(`refusing to purge: "${host}" is a hosted Supabase database (--force does not override this)`);
  }
  if (!isLocalDatabaseUrl(input.databaseUrl)) {
    if (!input.force) {
      throw new ResetRefusedError(
        `refusing to purge: database host ${host === null ? "(unparseable)" : `"${host}"`} is not localhost, 127.0.0.1 or ::1 (pass --force if this really is a disposable dev database)`,
      );
    }
  }
}

export interface PurgeResult {
  /** False when no org has the slug (nothing was deleted). */
  found: boolean;
  orgId: string | null;
  /** Rows deleted per table (tables with no rows for the org are omitted). */
  deleted: Record<string, number>;
}

/**
 * Deletes the org with `slug` and every row that carries its `org_id`, in one admin transaction
 * with triggers disabled (`session_replication_role = replica`). Checks `assertResetAllowed` first.
 */
export async function purgeDemoOrg(adminDb: Db, slug: string, guard: ResetGuardInput): Promise<PurgeResult> {
  assertResetAllowed(guard);
  try {
    return await adminDb.transaction(async (tx) => {
      // A forced non-local purge must not reach hosted Supabase by any name (an IP, a CNAME):
      // supautils is what lets its postgres role skip the triggers below.
      if (!isLocalDatabaseUrl(guard.databaseUrl)) {
        const [supautils] = await tx.execute<{ role: string | null }>(
          sql`select current_setting('supautils.privileged_role', true) as role`,
        );
        if (supautils?.role) throw new ResetRefusedError("refusing to purge: the database is a Supabase project (supautils is loaded)");
      }
      const found = await tx.execute<{ id: string }>(sql`select id from org where slug = ${slug} for update`);
      const orgId = found[0]?.id;
      if (!orgId) return { found: false, orgId: null, deleted: {} };

      // Transaction-local: ordinary triggers (append-only, chain) and FK triggers are skipped
      // until commit/rollback. Requires a superuser, or Supabase's postgres role (supautils allows it).
      await tx.execute(sql`set local session_replication_role = replica`);

      // Every base table with an org_id column, so a table added later is purged too.
      const tables = await tx.execute<{ table_name: string }>(sql`
        select c.table_name
          from information_schema.columns c
          join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
         where c.table_schema = 'public' and c.column_name = 'org_id' and t.table_type = 'BASE TABLE'
         order by c.table_name`);
      const deleted: Record<string, number> = {};
      for (const { table_name } of tables) {
        const rows = await tx.execute<{ n: number }>(
          sql`with d as (delete from ${sql.identifier(table_name)} where org_id = ${orgId} returning 1) select count(*)::int as n from d`,
        );
        const n = rows[0]?.n ?? 0;
        if (n > 0) deleted[table_name] = n;
      }
      await tx.execute(sql`delete from org where id = ${orgId}`);
      deleted.org = 1;
      return { found: true, orgId, deleted };
    });
  } catch (error) {
    // 42501: the role may not set session_replication_role (not a superuser).
    const pg = getPgError(error);
    if (pg?.code === "42501") throw new ResetRefusedError("the admin role cannot set session_replication_role (needs a superuser or Supabase's postgres role)");
    throw error;
  }
}
