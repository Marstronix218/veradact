// The SCRAM verifier cloud-setup.ts sends must let the role log in with the plain password.
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { scramSha256Verifier } from "./cloud";
import { adminTestDb } from "./testing";

const admin = adminTestDb();
const role = `scram_probe_${randomBytes(6).toString("hex")}`;

afterAll(async () => {
  await admin.sql.unsafe(`DROP ROLE IF EXISTS ${role}`);
  await admin.close();
});

async function loginAs(password: string): Promise<string> {
  const url = new URL(process.env.TEST_DATABASE_ADMIN_URL ?? "");
  url.username = role;
  url.password = password;
  const client = postgres(url.toString(), { max: 1, onnotice: () => {} });
  try {
    const [row] = await client<{ user: string }[]>`select current_user as user`;
    return row?.user ?? "";
  } finally {
    await client.end({ timeout: 5 });
  }
}

describe("scramSha256Verifier against Postgres", () => {
  it("sets a password the role can log in with, and a wrong one is refused", async () => {
    const password = randomBytes(32).toString("hex");
    await admin.sql.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${scramSha256Verifier(password)}'`);
    expect(await loginAs(password)).toBe(role);
    await expect(loginAs(`${password}x`)).rejects.toThrow(/password authentication failed/);
  });
});
