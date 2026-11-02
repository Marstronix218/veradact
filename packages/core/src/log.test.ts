import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { log, logError, logId, setLogWriter } from "./log";

const UUID = "8f0c2d4e-1a2b-4c3d-9e8f-0123456789ab";

let lines: Record<string, unknown>[];
let savedLevel: string | undefined;

beforeEach(() => {
  lines = [];
  savedLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "debug";
  setLogWriter((line) => lines.push(JSON.parse(line) as Record<string, unknown>));
});

afterEach(() => {
  setLogWriter(null);
  if (savedLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = savedLevel;
});

describe("log", () => {
  it("writes one JSON line with ts, level, event and the fields", () => {
    const role = "admin" as "admin" | "member";
    log.info("auth.login", { userId: logId(UUID), role, count: 2, ok: true, none: null });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "info", event: "auth.login", userId: UUID, role: "admin", count: 2, ok: true, none: null });
    expect(typeof lines[0]?.ts).toBe("string");
  });

  it("logs non-UUID ids as not_a_uuid", () => {
    log.info("x", { userId: logId("ada@example.test") });
    expect(lines[0]?.userId).toBe("not_a_uuid");
  });

  it("redacts free text and objects that slip past the types", () => {
    log.warn("x", {
      email: "ada@example.test" as never,
      sentence: "Ada Lovelace said hi" as never,
      nested: { secret: "token" } as never,
      list: ["a"] as never,
      nan: Number.NaN,
    });
    expect(lines[0]).toMatchObject({
      email: "[redacted]",
      sentence: "[redacted]",
      nested: "[redacted]",
      list: "[redacted]",
      nan: null,
    });
  });

  it("does not let fields overwrite ts, level or event", () => {
    log.info("real.event", { event: "fake" as const, level: "error" as const });
    expect(lines[0]).toMatchObject({ event: "real.event", level: "info" });
  });

  it("respects LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "warn";
    log.info("quiet");
    log.error("loud");
    expect(lines.map((l) => l.event)).toEqual(["loud"]);
  });

  it("only accepts ids, enums, counts and booleans at the type level", () => {
    const freeText: string = "Ada Lovelace";
    // @ts-expect-error a plain string could be anything (an email, a name)
    log.info("x", { name: freeText });
    // @ts-expect-error objects are not allowed
    log.info("x", { nested: { a: 1 } });
    // @ts-expect-error Dates are not allowed
    log.info("x", { at: new Date() });
    expect(lines.map((l) => l.name ?? l.nested ?? l.at)).toEqual(["[redacted]", "[redacted]", "[redacted]"]);
  });
});

describe("logError", () => {
  it("logs the error class and SQLSTATE/constraint, never the message", () => {
    const pg = Object.assign(new Error("duplicate key value violates unique constraint (ada@example.test)"), {
      name: "PostgresError",
      code: "23505",
      constraint_name: "app_user_email_unique",
    });
    const wrapped = Object.assign(new Error("Failed query: insert ... params: ada@example.test"), {
      name: "DrizzleQueryError",
      cause: pg,
    });
    logError("user.invite_failed", wrapped, { orgId: logId(UUID) });
    expect(lines[0]).toEqual({
      ts: expect.any(String),
      level: "error",
      event: "user.invite_failed",
      orgId: UUID,
      error: "DrizzleQueryError",
      sqlstate: "23505",
      constraint: "app_user_email_unique",
    });
    expect(JSON.stringify(lines)).not.toContain("ada@example.test");
  });

  it("logs a string code for non-Postgres errors", () => {
    logError("email.failed", Object.assign(new Error("550 ada@example.test rejected"), { code: "EENVELOPE" }));
    expect(lines[0]).toMatchObject({ error: "Error", code: "EENVELOPE" });
    expect(JSON.stringify(lines)).not.toContain("ada@");
  });

  it("handles thrown non-errors", () => {
    logError("weird", "ada@example.test");
    expect(lines[0]).toMatchObject({ error: "string" });
    expect(JSON.stringify(lines)).not.toContain("ada@");
  });
});
