// Pure helpers for `pnpm db:cloud-setup` (cloud-setup.ts).
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

const SCRAM_ITERATIONS = 4096;

/**
 * A SCRAM-SHA-256 verifier for `password` (RFC 7677; the format Postgres stores). `ALTER ROLE …
 * PASSWORD '<verifier>'` sets the password without the plain text reaching the server or its logs.
 * Only for ASCII passwords: SASLprep is the identity there.
 */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16)): string {
  if (!/^[\x20-\x7e]+$/.test(password)) throw new Error("scramSha256Verifier: printable ASCII passwords only");
  const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/**
 * The app-role URL for the database `adminUrl` points at: same host, port and database, user
 * `veradact_app` (with the Supavisor `.<project-ref>` suffix when the admin user has one), and
 * `sslmode=verify-full`.
 */
export function appUrlFromAdminUrl(adminUrl: string, appPassword: string): string {
  const url = new URL(adminUrl);
  const admin = decodeURIComponent(url.username);
  const dot = admin.indexOf(".");
  url.username = dot === -1 ? "veradact_app" : `veradact_app${admin.slice(dot)}`;
  url.password = encodeURIComponent(appPassword);
  url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}

/** `content` of a dotenv file with `key` set to `value` (double-quoted), replacing an existing line or appending one. */
export function setEnvLine(content: string, key: string, value: string): string {
  const line = `${key}=${JSON.stringify(value)}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(content)) return content.replace(pattern, () => line);
  return `${content.replace(/\n*$/, "\n")}${line}\n`;
}

/** `content` without the `key=` line, if any. */
export function removeEnvLine(content: string, key: string): string {
  return content.replace(new RegExp(`^${key}=.*\\n?`, "m"), "");
}
