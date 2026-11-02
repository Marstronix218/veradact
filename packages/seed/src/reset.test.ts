import { describe, expect, it } from "vitest";
import { assertResetAllowed, databaseHost, ResetRefusedError } from "./reset";

const LOCAL = "postgres://veradact_admin:veradact_admin@localhost:54330/veradact";

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

  it("parses the host of a connection string", () => {
    expect(databaseHost(LOCAL)).toBe("localhost");
    expect(databaseHost("garbage")).toBeNull();
  });
});
