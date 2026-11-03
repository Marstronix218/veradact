// The magic link (D-045). GET /auth/verify?token=… only renders a "Sign in to Veradact" page
// whose button POSTs the token, so mail scanners that prefetch links cannot burn it. The POST
// consumes the login token (single use), sets the session cookie and sends the user to the app.
// Every failure looks the same.
import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { verifyMagicLink } from "@veradact/core";
import { clock } from "@/lib/clock";
import { getDb } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { clientIpFrom, isCrossSite, readFormData } from "@/lib/request";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/session";

export const dynamic = "force-dynamic";

const MAX_TOKEN_LENGTH = 256;
/** The form carries one token; anything bigger is not ours. */
const MAX_FORM_BYTES = 4 * 1024;

const STYLE =
  "body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#fafafa;color:#18181b}" +
  "main{max-width:24rem;margin:0 auto;padding:4rem 1rem}h1{font-size:1.125rem;margin:0 0 .5rem}" +
  "p{font-size:.875rem;color:#52525b;margin:0 0 1.5rem}" +
  "button{width:100%;padding:.625rem 1rem;border:0;border-radius:.375rem;background:#18181b;color:#fff;font-size:.875rem;font-weight:600;cursor:pointer}";
const STYLE_HASH = createHash("sha256").update(STYLE).digest("base64");

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "Content-Security-Policy": `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function failure(base: string): NextResponse {
  const response = NextResponse.redirect(new URL("/login?error=link", base), 303);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

/** Renders the interstitial. Nothing is consumed or written. */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  if (token === "" || token.length > MAX_TOKEN_LENGTH) return failure(appUrl());
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Sign in to Veradact</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Sign in to Veradact</h1>
<p>Continue to sign in. The link works once and expires 15 minutes after it was sent.</p>
<form method="post" action="/auth/verify">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<button type="submit">Sign in to Veradact</button>
</form>
</main>
</body>
</html>`;
  return new NextResponse(html, { status: 200, headers: PAGE_HEADERS });
}

/** Consumes the token posted by the interstitial and opens a session. */
export async function POST(request: NextRequest) {
  const base = appUrl();
  // Login CSRF: only accept the form from our own interstitial.
  if (isCrossSite(request.headers, new URL(base).origin)) return failure(base);

  const form = await readFormData(request, MAX_FORM_BYTES);
  const token = form?.get("token");
  const result = await verifyMagicLink({
    db: getDb(),
    token: typeof token === "string" && token.length <= MAX_TOKEN_LENGTH ? token : null,
    clock,
    ip: clientIpFrom(request.headers),
  });
  if (result.status !== "ok") return failure(base);

  const response = NextResponse.redirect(new URL("/engagements", base), 303);
  response.cookies.set(SESSION_COOKIE, result.sessionToken, sessionCookieOptions(result.expiresAt));
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
