// Auth for server components, server actions and route handlers.
//
//   const auth = await requireAuth();                 // redirects to /login when signed out
//   const rows = await withAuthTenant((tx, auth) => tx.select().from(engagement));
//
// Never call these from middleware (postgres.js needs the Node runtime).
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { requireAdmin as coreRequireAdmin, resolveSession, type SessionAuth } from "@veradact/core";
import { withTenant, type Tx } from "@veradact/db";
import { clock } from "./clock";
import { getDb } from "./db";

export const SESSION_COOKIE = "vd_session";

/** The signed-in user's session, or null. Resolved once per request. */
export const getAuth = cache(async (): Promise<SessionAuth | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return resolveSession({ db: getDb(), token, clock });
});

/** The session, or a redirect to /login. */
export async function requireAuth(): Promise<SessionAuth> {
  const auth = await getAuth();
  if (!auth) redirect("/login");
  return auth;
}

/** The session of an org admin; throws core's `ForbiddenError` for members. */
export async function requireAdmin(): Promise<SessionAuth> {
  const auth = await requireAuth();
  coreRequireAdmin(auth);
  return auth;
}

/** Runs `fn` in a tenant transaction for the signed-in user (redirects to /login when signed out). */
export async function withAuthTenant<T>(fn: (tx: Tx, auth: SessionAuth) => Promise<T>): Promise<T> {
  const auth = await requireAuth();
  return withTenant(getDb(), { orgId: auth.orgId, userId: auth.userId }, (tx) => fn(tx, auth));
}
