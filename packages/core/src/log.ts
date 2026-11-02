// Structured logging (ARCHITECTURE §14, CLAUDE.md): JSON lines on stdout carrying ids, enums,
// counts and booleans only. Never source text, statements, quotes, comments, names, emails,
// IPs or tokens.
//
// The field type enforces this: values may be numbers, booleans, null, string-literal types
// (enums such as `role: UserRole`) or ids wrapped in `logId()`. A plain `string` (which could
// be anything) or an object does not compile. At runtime strings are checked again and
// anything that does not look like an id or an enum token is replaced by "[redacted]".
//
//   log.info("auth.login", { userId: logId(user.id), role: user.role, count: 2 });
//   logError("email.deliver_failed", err, { orgId: logId(orgId) });
import { getPgError } from "@veradact/db";

declare const LOG_ID: unique symbol;

/** A string checked to be a UUID by `logId()`. */
export type LogId = string & { readonly [LOG_ID]: true };

type CheckedValue<V> = V extends null | undefined | number | boolean
  ? V
  : V extends LogId
    ? V
    : V extends string
      ? string extends V
        ? LogId
        : V
      : never;

/** Maps each field to what it may hold; see the module comment. */
export type SafeFields<F> = { [K in keyof F]: CheckedValue<F[K]> };

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel | "silent", number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const RESERVED = new Set(["ts", "level", "event"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Enum values, codes, SQLSTATEs, error class names, event names. */
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const REDACTED = "[redacted]";

/** Wraps an id for logging. Anything that is not a UUID is logged as "not_a_uuid". */
export function logId(value: string): LogId {
  return (UUID.test(value) ? value : "not_a_uuid") as LogId;
}

type Writer = (line: string) => void;

const defaultWriter: Writer = (line) => {
  process.stdout.write(`${line}\n`);
};

let writer: Writer = defaultWriter;

/** Redirects log lines (tests). `null` restores stdout. */
export function setLogWriter(next: Writer | null): void {
  writer = next ?? defaultWriter;
}

function threshold(): number {
  const configured = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (configured && configured in LEVELS) return LEVELS[configured as LogLevel | "silent"];
  // Keep test output readable; tests that assert on logs install a writer and set LOG_LEVEL.
  return process.env.VITEST ? LEVELS.silent : LEVELS.info;
}

function safeString(value: string): string {
  return UUID.test(value) || (TOKEN.test(value) && !value.includes("@")) ? value : REDACTED;
}

function safeValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null || value === undefined || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return safeString(value);
  return REDACTED;
}

function emit(level: LogLevel, event: string, fields: object | undefined): void {
  if (LEVELS[level] < threshold()) return;
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event: safeString(event),
  };
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (RESERVED.has(key) || !TOKEN.test(key)) continue;
      const safe = safeValue(value);
      if (safe !== undefined) line[key] = safe;
    }
  }
  try {
    writer(JSON.stringify(line));
  } catch {
    // Logging must never take a request down.
  }
}

type LogFn = <F extends object = Record<never, never>>(event: string, fields?: F & SafeFields<F>) => void;

export const log: Record<LogLevel, LogFn> = {
  debug: (event, fields) => emit("debug", event, fields),
  info: (event, fields) => emit("info", event, fields),
  warn: (event, fields) => emit("warn", event, fields),
  error: (event, fields) => emit("error", event, fields),
};

/**
 * Logs a failure by error class name plus, when present, the Postgres SQLSTATE and
 * constraint (via `getPgError`, D-033) or a string `code` property. Never the message, which
 * for query errors embeds parameters and for provider errors often quotes addresses.
 */
export function logError<F extends object = Record<never, never>>(
  event: string,
  error: unknown,
  fields?: F & SafeFields<F>,
): void {
  const details: Record<string, string | undefined> = {
    error: error instanceof Error ? error.name : typeof error,
  };
  const pg = getPgError(error);
  if (pg) {
    details.sqlstate = pg.code;
    details.constraint = pg.constraint;
  } else if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") details.code = code;
  }
  emit("error", event, { ...fields, ...details });
}
