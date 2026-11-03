// Vendor sessions (ARCHITECTURE §2.1, §14, D-016). The cookie holds a random token; the
// database stores only its sha256. Resolution goes through the `auth_resolve_session`
// definer, which rejects revoked, expired (DB now()) and deactivated-user sessions.
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { appUser, authResolveSession, session, withTenant, type Db, type Tx } from "@veradact/db";
import { writeAudit } from "../audit";
import { hashToken, isRandomTokenShape, randomToken } from "../security/tokens";
import type { AuthContext } from "./context";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** `last_seen_at` is written at most this often per session. */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface SessionAuth extends AuthContext {
  sessionId: string;
  expiresAt: Date;
}

export interface NewSession {
  sessionId: string;
  /** Raw token for the cookie. Never stored or logged. */
  token: string;
  expiresAt: Date;
}

/** Inserts a session for the tenant of `tx`. Expiry is real time: the definer compares it with DB now(). */
export async function createSession(
  tx: Tx,
  input: { orgId: string; userId: string; now: Date },
): Promise<NewSession> {
  const token = randomToken();
  const expiresAt = new Date(input.now.getTime() + SESSION_TTL_MS);
  const [row] = await tx
    .insert(session)
    .values({
      orgId: input.orgId,
      userId: input.userId,
      tokenHash: hashToken(token),
      expiresAt,
      lastSeenAt: input.now,
      createdAt: input.now,
    })
    .returning({ id: session.id });
  if (!row) throw new Error("createSession: insert returned no row");
  return { sessionId: row.id, token, expiresAt };
}

export interface VerifiedLogin {
  /** Raw session token for the cookie. Never stored or logged. */
  sessionToken: string;
  expiresAt: Date;
  session: SessionAuth;
  user: { id: string; email: string; name: string } & Pick<AuthContext, "role">;
}

/**
 * Opens a session for a user a sign-in method has already authenticated (via a definer, so
 * `user` names its own tenant) and audits `auth.login` with that method. Internal to `auth/`:
 * not exported from the package, because it trusts its caller to have authenticated `user`.
 */
export async function openSession(
  db: Db,
  user: { orgId: string; userId: string },
  now: Date,
  method: "magic_link" | "demo_password",
): Promise<VerifiedLogin> {
  return withTenant(db, user, async (tx) => {
    const [row] = await tx
      .select({ id: appUser.id, email: appUser.email, name: appUser.name, role: appUser.role })
      .from(appUser)
      .where(eq(appUser.id, user.userId));
    if (!row) throw new Error("openSession: authenticated user has no row");
    const created = await createSession(tx, { orgId: user.orgId, userId: row.id, now });
    await writeAudit(tx, {
      orgId: user.orgId,
      actorUserId: row.id,
      action: "auth.login",
      targetType: "session",
      targetId: created.sessionId,
      metadata: { method },
      at: now,
    });
    return {
      sessionToken: created.token,
      expiresAt: created.expiresAt,
      session: { sessionId: created.sessionId, orgId: user.orgId, userId: row.id, role: row.role, expiresAt: created.expiresAt },
      user: row,
    };
  });
}

/**
 * The live session for a cookie value, or null. Refreshes `last_seen_at` when it is older
 * than `SESSION_TOUCH_INTERVAL_MS` (a no-op UPDATE otherwise).
 */
export async function resolveSession(input: {
  db: Db;
  token: string | null | undefined;
  clock: () => Date;
}): Promise<SessionAuth | null> {
  const { db, token, clock } = input;
  if (!token || !isRandomTokenShape(token)) return null;
  const resolved = await authResolveSession(db, hashToken(token));
  if (!resolved) return null;

  const now = clock();
  const staleBefore = new Date(now.getTime() - SESSION_TOUCH_INTERVAL_MS);
  await withTenant(db, { orgId: resolved.orgId, userId: resolved.userId }, (tx) =>
    tx
      .update(session)
      .set({ lastSeenAt: now })
      .where(
        and(
          eq(session.id, resolved.sessionId),
          or(isNull(session.lastSeenAt), lt(session.lastSeenAt, staleBefore)),
        ),
      ),
  );

  return {
    sessionId: resolved.sessionId,
    orgId: resolved.orgId,
    userId: resolved.userId,
    role: resolved.role,
    expiresAt: resolved.expiresAt,
  };
}

/** Revokes the session behind a cookie value and audits `auth.logout`. False when it was not live. */
export async function logout(input: {
  db: Db;
  token: string | null | undefined;
  clock: () => Date;
}): Promise<boolean> {
  const { db, token, clock } = input;
  if (!token || !isRandomTokenShape(token)) return false;
  const resolved = await authResolveSession(db, hashToken(token));
  if (!resolved) return false;

  const now = clock();
  return withTenant(db, { orgId: resolved.orgId, userId: resolved.userId }, async (tx) => {
    const revoked = await tx
      .update(session)
      .set({ revokedAt: now })
      .where(and(eq(session.id, resolved.sessionId), isNull(session.revokedAt)))
      .returning({ id: session.id });
    if (revoked.length === 0) return false;
    await writeAudit(tx, {
      orgId: resolved.orgId,
      actorUserId: resolved.userId,
      action: "auth.logout",
      targetType: "session",
      targetId: resolved.sessionId,
      at: now,
    });
    return true;
  });
}
