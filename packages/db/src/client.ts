import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

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
 */
export function createDb(url: string, options: CreateDbOptions = {}) {
  const sql = postgres(url, {
    max: options.max ?? 10,
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

export type DbHandle = ReturnType<typeof createDb>;
export type Db = DbHandle["db"];
export type Sql = DbHandle["sql"];
