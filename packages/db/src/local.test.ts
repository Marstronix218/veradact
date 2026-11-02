import { describe, expect, it } from "vitest";
import { connectionHosts, isLocalDatabaseUrl } from "./local";

describe("connectionHosts", () => {
  it("returns the hosts postgres.js connects to, including a ?host= override", () => {
    expect(connectionHosts("postgres://u:p@LOCALHOST:54330/postgres")).toEqual(["localhost"]);
    expect(connectionHosts("postgres://u:p@localhost:5432/db?host=aws-0-eu.pooler.supabase.com")).toEqual([
      "aws-0-eu.pooler.supabase.com",
    ]);
    expect(connectionHosts("postgresql://u:p@localhost,db.internal.example:5432/db")).toEqual([
      "localhost",
      "db.internal.example",
    ]);
  });

  it("returns null for anything that is not a postgres URL", () => {
    expect(connectionHosts("not a url")).toBeNull();
    expect(connectionHosts("mysql://u:p@localhost/db")).toBeNull();
  });
});

describe("isLocalDatabaseUrl", () => {
  it("accepts loopback names and addresses and Unix sockets", () => {
    expect(isLocalDatabaseUrl("postgres://u:p@localhost:54330/postgres")).toBe(true);
    expect(isLocalDatabaseUrl("postgres://u:p@127.0.0.1/db")).toBe(true);
    expect(isLocalDatabaseUrl("postgres://u:p@[::1]:5432/db")).toBe(true);
    expect(isLocalDatabaseUrl("postgres://u:p@localhost/db?host=/var/run/postgresql")).toBe(true);
  });

  it("rejects a remote host, even behind a local-looking URL", () => {
    expect(isLocalDatabaseUrl("postgres://u:p@db.supabase.co:5432/postgres")).toBe(false);
    expect(isLocalDatabaseUrl("postgres://u:p@localhost/db?host=aws-0-eu.pooler.supabase.com")).toBe(false);
    expect(isLocalDatabaseUrl("postgres://u:p@localhost,db.internal.example/db")).toBe(false);
    expect(isLocalDatabaseUrl("postgres://u:p@localhost.example.com/db")).toBe(false);
    expect(isLocalDatabaseUrl("not a url")).toBe(false);
  });
});
