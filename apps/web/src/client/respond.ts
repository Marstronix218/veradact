// Responses for the client pages (ARCHITECTURE §8.3): strict CSP (no scripts at all, same-origin
// stylesheet only), no referrer, not indexed, never cached.
export const CLIENT_CSP = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export const CLIENT_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": CLIENT_CSP,
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export function htmlResponse(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...CLIENT_SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8", ...extra },
  });
}

/** 303 See Other to a same-origin path (post/redirect/get). */
export function seeOther(path: string): Response {
  return new Response(null, { status: 303, headers: { ...CLIENT_SECURITY_HEADERS, Location: path } });
}
