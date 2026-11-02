// Request metadata for rate limiting and evidence. IPs and user agents are personal data:
// pass them to core (which hashes IPs for rate limits) and never log them.
import { headers } from "next/headers";
import { clientIpFromForwardedFor, trustedProxyHops } from "@veradact/core";

type HeaderSource = Pick<Headers, "get">;

const MAX_USER_AGENT_LENGTH = 512;

/**
 * Client IP for rate limits and evidence: the `X-Forwarded-For` entry written by the first trusted
 * proxy (`TRUSTED_PROXY_HOPS`, default 1), else "unknown". Next fills the header with the socket
 * address when it is absent; with `TRUSTED_PROXY_HOPS=0` (no proxy) it is ignored entirely, because
 * a client can send it.
 */
export function clientIpFrom(h: HeaderSource): string {
  return clientIpFromForwardedFor(h.get("x-forwarded-for"), trustedProxyHops(), "unknown");
}

export function userAgentFrom(h: HeaderSource): string | null {
  const ua = h.get("user-agent")?.trim();
  return ua ? ua.slice(0, MAX_USER_AGENT_LENGTH) : null;
}

/** IP and user agent of the current request (server components and server actions). */
export async function requestInfo(): Promise<{ ip: string; userAgent: string | null }> {
  const h = await headers();
  return { ip: clientIpFrom(h), userAgent: userAgentFrom(h) };
}

/**
 * CSRF check for plain HTML form POSTs (the magic-link interstitial, the client pages).
 * `Sec-Fetch-Site` decides when present (every current browser sends it). Without it, a real
 * Origin must be ours, and `Origin: null` — what browsers send from pages with
 * `Referrer-Policy: no-referrer`, but also from sandboxed frames and some redirects — counts as
 * cross-site unless `allowNullOrigin` (the client pages, whose token is the credential anyway).
 * A request with neither header (not a browser) is not cross-site.
 */
export function isCrossSite(h: HeaderSource, appOrigin: string, options: { allowNullOrigin?: boolean } = {}): boolean {
  const site = h.get("sec-fetch-site");
  if (site !== null) return site !== "same-origin";
  const origin = h.get("origin");
  if (origin === null) return false;
  if (origin === "null") return !options.allowNullOrigin;
  return origin !== appOrigin;
}

/**
 * Reads a urlencoded or multipart form of at most `maxBytes` (by `Content-Length` and by what
 * actually arrives), or null when it is larger or unreadable. Keeps oversized bodies from being
 * buffered before the form is looked at.
 */
export async function readFormData(request: Request, maxBytes: number): Promise<FormData | null> {
  if (Number(request.headers.get("content-length") ?? "0") > maxBytes) return null;
  if (!request.body) return new FormData();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  try {
    return await new Response(Buffer.concat(chunks), { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
  } catch {
    return null;
  }
}
