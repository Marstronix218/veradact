// GET /auth/verify?token=… — the magic link. Consumes the login token (single use), sets the
// session cookie and sends the user to the app. Every failure looks the same.
import { NextResponse, type NextRequest } from "next/server";
import { verifyMagicLink } from "@veradact/core";
import { clock } from "@/lib/clock";
import { getDb } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { clientIpFrom, isHttpsRequest } from "@/lib/request";
import { SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const base = appUrl();
  const result = await verifyMagicLink({
    db: getDb(),
    token: request.nextUrl.searchParams.get("token"),
    clock,
    ip: clientIpFrom(request.headers),
  });
  if (result.status !== "ok") {
    return NextResponse.redirect(new URL("/login?error=link", base), 303);
  }
  const response = NextResponse.redirect(new URL("/engagements", base), 303);
  response.cookies.set(SESSION_COOKIE, result.sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttpsRequest(request.headers, base),
    path: "/",
    expires: result.expiresAt,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
