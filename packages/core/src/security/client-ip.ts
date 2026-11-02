// Client IP behind reverse proxies (ARCHITECTURE §14). Each proxy appends the address it received
// the request from to `X-Forwarded-For`, so only the rightmost `TRUSTED_PROXY_HOPS` entries were
// written by infrastructure we control; anything to their left came from the client and can be
// forged. The IP is used as a rate-limit key (hashed) and as confirmation evidence, never logged.

export const DEFAULT_TRUSTED_PROXY_HOPS = 1;
const MAX_TRUSTED_PROXY_HOPS = 10;

/**
 * `TRUSTED_PROXY_HOPS`: how many proxies in front of the server append to `X-Forwarded-For`.
 * Unset = 1 (one load balancer or platform proxy). 0 = no proxy: the header is ignored.
 * Throws on anything else, so a typo fails at startup instead of silently trusting the client.
 */
export function trustedProxyHops(env: Record<string, string | undefined> = process.env): number {
  const raw = env.TRUSTED_PROXY_HOPS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_TRUSTED_PROXY_HOPS;
  const hops = Number(raw);
  if (!/^\d+$/.test(raw) || hops > MAX_TRUSTED_PROXY_HOPS) {
    throw new Error(`TRUSTED_PROXY_HOPS must be a whole number from 0 to ${MAX_TRUSTED_PROXY_HOPS}`);
  }
  return hops;
}

/**
 * The address the first trusted proxy saw: the entry `hops` places from the right of
 * `X-Forwarded-For` (the leftmost one when the header is shorter). Returns `fallback` (the socket
 * address, or "unknown" where there is none) when `hops` is 0 or the header is empty.
 */
export function clientIpFromForwardedFor(header: string | null | undefined, hops: number, fallback: string): string {
  if (hops <= 0 || !header) return fallback;
  const entries = header
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0) return fallback;
  return entries[Math.max(0, entries.length - hops)]!;
}
