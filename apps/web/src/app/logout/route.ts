// POST /logout — revokes the session (audited) and clears the cookie. SameSite=Lax keeps the
// cookie off cross-site POSTs, so another site cannot log a user out.
import { NextResponse, type NextRequest } from "next/server";
import { logout } from "@veradact/core";
import { clock } from "@/lib/clock";
import { getDb } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { isHttpsRequest } from "@/lib/request";
import { SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const base = appUrl();
  await logout({ db: getDb(), token: request.cookies.get(SESSION_COOKIE)?.value, clock });
  const response = NextResponse.redirect(new URL("/login", base), 303);
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttpsRequest(request.headers, base),
    path: "/",
    maxAge: 0,
  });
  return response;
}
