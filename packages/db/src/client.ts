import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { connectionHosts } from "./local";
import * as schema from "./schema";
import { SUPABASE_ROOT_CA_2021 } from "./supabase-ca";

const INT8 = 20;
const TIMESTAMPTZ = 1184;

export interface CreateDbOptions {
  /** Pool size (postgres.js default 10). */
  max?: number;
}

/**
 * postgres.js + Drizzle over one pool (ARCHITECTURE §1.1):
 * - `int8` parses to a JS number (seq/id values stay far below 2^53);
 * - `jsonb` returns parsed objects;
 * - `timestamptz` returns `Date`, for typed Drizzle selects and for raw `sql` / `db.execute`.
 *
 * Raw `sql` queries must pass jsonb parameters as `JSON.stringify(value)` (Drizzle disables
 * postgres.js's JSON serializer so its own stringified values are not encoded twice).
 *
 * TLS: see `tlsOptions`.
 */
export function createDb(url: string, options: CreateDbOptions = {}) {
  const sql = postgres(url, {
    max: options.max ?? 10,
    ssl: tlsOptions(url),
    types: {
      int8: {
        to: INT8,
        from: [INT8],
        serialize: (value: number | bigint | string) => String(value),
        parse: (value: string) => Number(value),
      },
    },
    onnotice: () => {},
  });

  // drizzle() replaces the timestamptz parser with an identity function and maps strings to
  // Date only for typed selects. Restore postgres.js's Date parsing so raw rows match;
  // Drizzle's timestamp mapping passes Date values through unchanged.
  const parseTimestamptz = sql.options.parsers[TIMESTAMPTZ];
  const serializeTimestamptz = sql.options.serializers[TIMESTAMPTZ];
  const db = drizzle({ client: sql, schema });
  if (parseTimestamptz) sql.options.parsers[TIMESTAMPTZ] = parseTimestamptz;
  if (serializeTimestamptz) sql.options.serializers[TIMESTAMPTZ] = serializeTimestamptz;

  return {
    sql,
    db,
    close: () => sql.end({ timeout: 5 }),
  };
}

const SUPABASE_HOST = /\.supabase\.(co|com)\.?$/;

/**
 * postgres.js `ssl` for `url` (also used by migrations), verifying the server certificate and host
 * name against one CA, for database connections only (ARCHITECTURE §17.1):
 * - `DATABASE_CA_CERT_FILE` (a PEM file) when set;
 * - else, for hosted Supabase, Supabase's public root CA, whatever `sslmode` says;
 * - else undefined, so the URL's `sslmode` applies.
 */
export function tlsOptions(url: string): { ca: string; rejectUnauthorized: true } | undefined {
  const caFile = process.env.DATABASE_CA_CERT_FILE?.trim();
  if (caFile) return { ca: readFileSync(caFile, "utf8"), rejectUnauthorized: true };
  const hosts = connectionHosts(url);
  if (hosts?.length && hosts.every((host) => SUPABASE_HOST.test(host))) {
    return { ca: SUPABASE_ROOT_CA_2021, rejectUnauthorized: true };
  }
  return undefined;
}

export type DbHandle = ReturnType<typeof createDb>;
export type Db = DbHandle["db"];
export type Sql = DbHandle["sql"];
