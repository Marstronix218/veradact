import { describe, expect, it } from "vitest";
import { assertResetAllowed, databaseHost, ResetRefusedError } from "./reset";

const LOCAL = "postgres://postgres:postgres@localhost:54330/postgres";

describe("assertResetAllowed (dev-only reset guard)", () => {
  it("allows localhost and 127.0.0.1 outside production", () => {
    expect(() => assertResetAllowed({ databaseUrl: LOCAL, nodeEnv: undefined })).not.toThrow();
    expect(() => assertResetAllowed({ databaseUrl: "postgres://u:p@127.0.0.1:5432/db", nodeEnv: "development" })).not.toThrow();
  });

  it("refuses NODE_ENV=production, even with --force", () => {
    expect(() => assertResetAllowed({ databaseUrl: LOCAL, nodeEnv: "production" })).toThrow(ResetRefusedError);
    expect(() => assertResetAllowed({ databaseUrl: LOCAL, nodeEnv: " Production ", force: true })).toThrow(/NODE_ENV/);
  });

  it("refuses a non-local or unparseable host unless forced", () => {
    const remote = "postgres://u:p@db.internal.example:5432/veradact";
    expect(() => assertResetAllowed({ databaseUrl: remote, nodeEnv: undefined })).toThrow(/not localhost/);
    expect(() => assertResetAllowed({ databaseUrl: "not a url", nodeEnv: undefined })).toThrow(ResetRefusedError);
    expect(() => assertResetAllowed({ databaseUrl: "postgres://u:p@localhost.example.com/db", nodeEnv: undefined })).toThrow(ResetRefusedError);
    expect(() => assertResetAllowed({ databaseUrl: remote, nodeEnv: undefined, force: true })).not.toThrow();
  });

  it("checks the host postgres.js connects to, not the one in the URL", () => {
    const overridden = "postgres://u:p@localhost:5432/db?host=db.internal.example";
    expect(() => assertResetAllowed({ databaseUrl: overridden, nodeEnv: undefined })).toThrow(/not localhost/);
    expect(() => assertResetAllowed({ databaseUrl: "postgres://u:p@localhost,db.internal.example/db", nodeEnv: undefined })).toThrow(ResetRefusedError);
    expect(() => assertResetAllowed({ databaseUrl: "postgres://u:p@[::1]:5432/db", nodeEnv: undefined })).not.toThrow();
  });

  it("refuses hosted Supabase, even with --force", () => {
    for (const databaseUrl of [
      "postgres://postgres.abcdefghijklmnop:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres",
      "postgres://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres",
      "postgres://postgres:pw@db.abcdefghijklmnop.supabase.co.:5432/postgres",
      "postgres://postgres:pw@localhost:5432/postgres?host=aws-0-eu-central-1.pooler.supabase.com",
    ]) {
      expect(() => assertResetAllowed({ databaseUrl, nodeEnv: undefined, force: true })).toThrow(/hosted Supabase/);
    }
  });

  it("parses the host of a connection string", () => {
    expect(databaseHost(LOCAL)).toBe("localhost");
    expect(databaseHost("postgres://u:p@localhost/db?host=db.internal.example")).toBe("db.internal.example");
    expect(databaseHost("garbage")).toBeNull();
  });
});
