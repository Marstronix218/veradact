// Request metadata for rate limiting and evidence. IPs and user agents are personal data:
// pass them to core (which hashes IPs for rate limits) and never log them.
import { headers } from "next/headers";

type HeaderSource = Pick<Headers, "get">;

const MAX_USER_AGENT_LENGTH = 512;

/**
 * Client IP: the first `x-forwarded-for` entry (set by the proxy in front of the app), else
 * `x-real-ip`, else "unknown". Deploy behind a proxy that overwrites these headers.
 */
export function clientIpFrom(h: HeaderSource): string {
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return h.get("x-real-ip")?.trim() || "unknown";
}

export function userAgentFrom(h: HeaderSource): string | null {
  const ua = h.get("user-agent")?.trim();
  return ua ? ua.slice(0, MAX_USER_AGENT_LENGTH) : null;
}

/** True when the original request was HTTPS (directly or via `x-forwarded-proto`). */
export function isHttpsRequest(h: HeaderSource, url?: string): boolean {
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (proto) return proto === "https";
  return url ? new URL(url).protocol === "https:" : false;
}

/** IP and user agent of the current request (server components and server actions). */
export async function requestInfo(): Promise<{ ip: string; userAgent: string | null }> {
  const h = await headers();
  return { ip: clientIpFrom(h), userAgent: userAgentFrom(h) };
}
