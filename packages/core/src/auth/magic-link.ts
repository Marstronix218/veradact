// Magic-link login (ARCHITECTURE §2.1, §14, D-016): a hashed, single-use, 15-minute login
// token emailed as `${appUrl}/auth/verify?token=…`, exchanged for a 30-day session.
//
// No user enumeration: known and unknown addresses take the same path up to the response
// (both rate-limit buckets are charged, a token is generated, the definer lookup runs) and
// return the same result. Pass `defer` (Next's `after`) so delivery happens after the
// response and SMTP latency cannot reveal whether the address belongs to a user.
import { appUser, authConsumeLoginToken, authFindUserByEmail, loginToken, withTenant, type Db } from "@veradact/db";
import { eq } from "drizzle-orm";
import type { EmailProvider } from "@veradact/email";
import { writeAudit } from "../audit";
import { log, logError, logId } from "../log";
import { checkRateLimit } from "../security/rate-limit";
import { hashToken, isRandomTokenShape, randomToken } from "../security/tokens";
import type { AuthContext } from "./context";
import { normalizeEmail } from "./email-address";
import { createSession, type SessionAuth } from "./session";

export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Fixed windows for login (ARCHITECTURE §14). */
export const MAGIC_LINK_RATE_LIMITS = {
  perIp: { limit: 20, windowSeconds: 15 * 60 },
  perEmail: { limit: 5, windowSeconds: 15 * 60 },
  verifyPerIp: { limit: 30, windowSeconds: 15 * 60 },
} as const;

export interface RequestMagicLinkInput {
  db: Db;
  email: string;
  clock: () => Date;
  emailProvider: EmailProvider;
  /** Public base URL of the web app, e.g. `https://app.example.com`. */
  appUrl: string;
  /** Client IP for the per-IP limit (hashed; never stored raw). */
  ip: string;
  /**
   * Schedules delivery after the response (e.g. `next/server` `after`). The task never
   * throws. Default: delivery is awaited before returning.
   */
  defer?: (task: () => Promise<void>) => void;
}

export type RequestMagicLinkResult =
  | { status: "accepted" }
  | { status: "invalid_email" }
  | { status: "rate_limited"; retryAfterSeconds: number };

function verifyUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, "")}/auth/verify?token=${encodeURIComponent(token)}`;
}

export async function requestMagicLink(input: RequestMagicLinkInput): Promise<RequestMagicLinkResult> {
  const { db, clock, emailProvider, appUrl, ip, defer } = input;
  const now = clock();

  const byIp = await checkRateLimit(db, { scope: "magic_link_ip", id: ip, now, ...MAGIC_LINK_RATE_LIMITS.perIp });
  if (!byIp.allowed) return { status: "rate_limited", retryAfterSeconds: byIp.retryAfterSeconds };

  const email = normalizeEmail(input.email);
  if (!email) return { status: "invalid_email" };

  const byEmail = await checkRateLimit(db, {
    scope: "magic_link_email",
    id: email,
    now,
    ...MAGIC_LINK_RATE_LIMITS.perEmail,
  });
  if (!byEmail.allowed) return { status: "rate_limited", retryAfterSeconds: byEmail.retryAfterSeconds };

  const token = randomToken();
  const tokenHash = hashToken(token);
  const user = await authFindUserByEmail(db, email);
  if (!user) return { status: "accepted" };

  await withTenant(db, user, (tx) =>
    tx.insert(loginToken).values({
      orgId: user.orgId,
      userId: user.userId,
      tokenHash,
      expiresAt: new Date(now.getTime() + LOGIN_TOKEN_TTL_MS),
      createdAt: now,
    }),
  );
  log.info("auth.magic_link.issued", { userId: logId(user.userId), orgId: logId(user.orgId) });

  const link = verifyUrl(appUrl, token);
  const deliver = async (): Promise<void> => {
    try {
      await emailProvider.send({
        to: email,
        subject: "Your Veradact sign-in link",
        text:
          "Use this link to sign in to Veradact. It works once and expires in 15 minutes.\n\n" +
          `${link}\n\n` +
          "If you did not ask to sign in, you can ignore this email.\n",
        tags: { kind: "magic_link" },
      });
    } catch (error) {
      logError("auth.magic_link.delivery_failed", error, { userId: logId(user.userId) });
    }
  };
  if (defer) defer(deliver);
  else await deliver();
  return { status: "accepted" };
}

export interface VerifiedLogin {
  /** Raw session token for the cookie. Never stored or logged. */
  sessionToken: string;
  expiresAt: Date;
  session: SessionAuth;
  user: { id: string; email: string; name: string } & Pick<AuthContext, "role">;
}

export type VerifyMagicLinkResult =
  | ({ status: "ok" } & VerifiedLogin)
  | { status: "invalid" }
  | { status: "rate_limited"; retryAfterSeconds: number };

/**
 * Consumes a login token (single use, via the definer) and opens a session, auditing
 * `auth.login`. Unknown, used, expired and deactivated-user tokens are all `invalid`.
 */
export async function verifyMagicLink(input: {
  db: Db;
  token: string | null | undefined;
  clock: () => Date;
  /** Client IP for the per-IP verify limit (hashed; never stored raw). */
  ip: string;
}): Promise<VerifyMagicLinkResult> {
  const { db, token, clock, ip } = input;
  const now = clock();
  const limit = await checkRateLimit(db, {
    scope: "magic_link_verify_ip",
    id: ip,
    now,
    ...MAGIC_LINK_RATE_LIMITS.verifyPerIp,
  });
  if (!limit.allowed) return { status: "rate_limited", retryAfterSeconds: limit.retryAfterSeconds };
  if (!token || !isRandomTokenShape(token)) return { status: "invalid" };

  const consumed = await authConsumeLoginToken(db, hashToken(token));
  if (!consumed) return { status: "invalid" };

  return withTenant(db, { orgId: consumed.orgId, userId: consumed.userId }, async (tx) => {
    const [user] = await tx
      .select({ id: appUser.id, email: appUser.email, name: appUser.name, role: appUser.role })
      .from(appUser)
      .where(eq(appUser.id, consumed.userId));
    if (!user) throw new Error("verifyMagicLink: consumed token has no user");
    const created = await createSession(tx, { orgId: consumed.orgId, userId: user.id, now });
    await writeAudit(tx, {
      orgId: consumed.orgId,
      actorUserId: user.id,
      action: "auth.login",
      targetType: "session",
      targetId: created.sessionId,
      metadata: { method: "magic_link" },
      at: now,
    });
    return {
      status: "ok",
      sessionToken: created.token,
      expiresAt: created.expiresAt,
      session: {
        sessionId: created.sessionId,
        orgId: consumed.orgId,
        userId: user.id,
        role: user.role,
        expiresAt: created.expiresAt,
      },
      user,
    } as const;
  });
}
