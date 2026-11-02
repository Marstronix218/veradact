/** The parts of a Postgres error that are safe to log: SQLSTATE and constraint name. */
export interface PgErrorInfo {
  code: string;
  constraint: string | undefined;
  /** Server message. May name tables/constraints; never log `detail`, which can hold values. */
  message: string;
}

/**
 * Extracts the Postgres error from a thrown value. Drizzle wraps driver errors in
 * DrizzleQueryError, whose own message embeds the query parameters (possible PII), so
 * log this instead of the thrown error.
 */
export function getPgError(error: unknown): PgErrorInfo | null {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    const candidate = e as { name?: unknown; code?: unknown; constraint_name?: unknown; message?: unknown };
    if (candidate.name === "PostgresError" && typeof candidate.code === "string") {
      return {
        code: candidate.code,
        constraint: typeof candidate.constraint_name === "string" ? candidate.constraint_name : undefined,
        message: typeof candidate.message === "string" ? candidate.message : "",
      };
    }
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}
