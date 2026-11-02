import { describe, expect, it } from "vitest";
import { appUrlFromAdminUrl, removeEnvLine, scramSha256Verifier, setEnvLine } from "./cloud";

describe("scramSha256Verifier", () => {
  it("formats a Postgres SCRAM-SHA-256 verifier", () => {
    const verifier = scramSha256Verifier("pencil", Buffer.alloc(16, 1));
    expect(verifier).toMatch(/^SCRAM-SHA-256\$4096:AQEBAQEBAQEBAQEBAQEBAQ==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);
    expect(scramSha256Verifier("pencil", Buffer.alloc(16, 1))).toBe(verifier);
    expect(scramSha256Verifier("pencil")).not.toBe(verifier);
  });

  it("refuses non-ASCII passwords (SASLprep is not implemented)", () => {
    expect(() => scramSha256Verifier("pässword")).toThrow(/ASCII/);
  });
});

describe("appUrlFromAdminUrl", () => {
  it("keeps host, port and database and switches to the app role with the Supavisor suffix", () => {
    const admin = "postgres://postgres.abcdefghijklmnop:s3cret@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require";
    expect(appUrlFromAdminUrl(admin, "ab12")).toBe(
      "postgres://veradact_app.abcdefghijklmnop:ab12@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
    );
  });

  it("uses the bare role for a direct connection", () => {
    expect(appUrlFromAdminUrl("postgres://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres", "ab12")).toBe(
      "postgres://veradact_app:ab12@db.abcdefghijklmnop.supabase.co:5432/postgres?sslmode=verify-full",
    );
  });
});

describe("setEnvLine / removeEnvLine", () => {
  const file = '# comment\nDATABASE_ADMIN_URL="postgres://a"\nDATABASE_URL="postgres://old"\nDATABASE_CA_CERT_FILE="/x.crt"\n';

  it("replaces an existing line and leaves the rest alone", () => {
    expect(setEnvLine(file, "DATABASE_URL", "postgres://new?a=1&b=$2")).toBe(
      '# comment\nDATABASE_ADMIN_URL="postgres://a"\nDATABASE_URL="postgres://new?a=1&b=$2"\nDATABASE_CA_CERT_FILE="/x.crt"\n',
    );
  });

  it("appends a missing line", () => {
    expect(setEnvLine("A=1", "DATABASE_URL", "x")).toBe('A=1\nDATABASE_URL="x"\n');
  });

  it("removes a line", () => {
    expect(removeEnvLine(file, "DATABASE_CA_CERT_FILE")).toBe('# comment\nDATABASE_ADMIN_URL="postgres://a"\nDATABASE_URL="postgres://old"\n');
  });
});
