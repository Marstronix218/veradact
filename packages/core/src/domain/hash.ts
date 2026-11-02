import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** SHA-256 as lowercase hex. Strings are hashed as their UTF-8 bytes. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** HMAC-SHA256(key, utf8(data)) as lowercase hex. */
export function hmacSha256Hex(key: Uint8Array, data: string): string {
  return createHmac("sha256", key).update(data, "utf8").digest("hex");
}

const HEX = /^(?:[0-9a-fA-F]{2})*$/;

/**
 * Constant-time comparison of two hex strings (case-insensitive). Returns false for malformed hex
 * or different lengths; the length check itself is not constant time, which leaks nothing useful
 * for fixed-length digests.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || !HEX.test(a) || !HEX.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
