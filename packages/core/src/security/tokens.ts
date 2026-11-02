// Random bearer secrets and their stored form (ARCHITECTURE §2.1: raw secrets are never
// stored; `*_hash = sha256(raw token)`).
import { createHash, randomBytes } from "node:crypto";

/** Bytes of entropy in every login, session and API token. */
export const TOKEN_BYTES = 32;

/** base64url without padding of 32 random bytes: 43 characters. */
const RAW_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** `bytes` random bytes as unpadded base64url. */
export function randomToken(bytes = TOKEN_BYTES): string {
  return randomBytes(bytes).toString("base64url");
}

/** True for strings shaped like `randomToken()` output; lets callers skip a DB round trip. */
export function isRandomTokenShape(value: string): boolean {
  return RAW_TOKEN.test(value);
}

/** Lowercase hex SHA-256 of the UTF-8 string: what `*_hash` columns store. */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}
