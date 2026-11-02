import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { customType, timestamp, uuid } from "drizzle-orm/pg-core";

/** Case-insensitive text (extension created in the first migration). */
export const citext = customType<{ data: string }>({
  dataType: () => "citext",
});

/** postgres.js reads and writes bytea as Buffer. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * `timestamp(3) with time zone`. Values always come from the application clock
 * (ARCHITECTURE §1.1), so no timestamp column has a SQL default.
 */
export const tstz = (name: string) =>
  timestamp(name, { withTimezone: true, precision: 3, mode: "date" });

/** UUID primary key generated in the application; callers may pass their own. */
export const appId = (name = "id") =>
  uuid(name)
    .primaryKey()
    .$defaultFn(() => randomUUID());

/** `"column" in ('a', 'b')` for CHECK constraints. Values are code constants. */
export const oneOf = (column: string, values: readonly string[]): SQL =>
  sql.raw(`"${column}" in (${values.map((v) => `'${v}'`).join(", ")})`);
