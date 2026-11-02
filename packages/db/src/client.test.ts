import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "./client";
import { SUPABASE_ROOT_CA_2021 } from "./supabase-ca";

const URL = "postgres://u:p@db.example.test:5432/postgres?sslmode=verify-full";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createDb TLS options", () => {
  it("takes sslmode from the URL when no CA file is set", async () => {
    vi.stubEnv("DATABASE_CA_CERT_FILE", "");
    const handle = createDb(URL);
    expect(handle.sql.options.ssl).toBe("verify-full");
    await handle.close();
  });

  it("verifies hosted Supabase against Supabase's root CA, even with sslmode=require", async () => {
    vi.stubEnv("DATABASE_CA_CERT_FILE", "");
    const handle = createDb("postgres://veradact_app.ref:p@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require");
    expect(handle.sql.options.ssl).toEqual({ ca: SUPABASE_ROOT_CA_2021, rejectUnauthorized: true });
    await handle.close();
  });

  it("verifies against the CA in DATABASE_CA_CERT_FILE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "veradact-ca-"));
    const file = join(dir, "ca.pem");
    writeFileSync(file, "-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n");
    vi.stubEnv("DATABASE_CA_CERT_FILE", file);
    try {
      const handle = createDb(URL);
      expect(handle.sql.options.ssl).toEqual({
        ca: "-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n",
        rejectUnauthorized: true,
      });
      await handle.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
