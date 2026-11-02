// Shared plumbing for the `/api/cron/*` routes (ARCHITECTURE §8.6, §6, §17): the platform scheduler
// calls them with `Authorization: Bearer ${CRON_SECRET}`.
import { createHash, timingSafeEqual } from "node:crypto";
import { isWeakSecret } from "@veradact/core";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/**
 * True when the header carries `CRON_SECRET` as a bearer token. Compares sha256 digests, so the
 * comparison is constant time whatever the lengths. An unset secret, and in production a
 * placeholder or short one, authorizes nothing.
 */
export function isCronAuthorized(header: string | null): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || !header?.startsWith("Bearer ")) return false;
  if (process.env.NODE_ENV === "production" && isWeakSecret(secret)) return false;
  return timingSafeEqual(digest(header.slice("Bearer ".length).trim()), digest(secret));
}

export function cronJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
