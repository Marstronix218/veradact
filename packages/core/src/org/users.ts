// Org members (ARCHITECTURE §2.1, §6, §14). Everyone in the org can list them; only admins
// invite and deactivate. One org per user in the MVP, so `app_user.email` is globally unique.
import { and, asc, eq, isNull } from "drizzle-orm";
import { apiToken, appUser, getPgError, org, session, userRoles, withTenant, type Db, type UserRole } from "@veradact/db";
import type { EmailProvider } from "@veradact/email";
import { writeAudit } from "../audit";
import { requireAdmin, type AuthContext } from "../auth/context";
import { normalizeEmail } from "../auth/email-address";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitedError, ValidationError } from "../errors";
import { log, logError, logId } from "../log";
import { checkRateLimit } from "../security/rate-limit";

export interface OrgUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  deactivatedAt: Date | null;
  createdAt: Date;
}

const columns = {
  id: appUser.id,
  email: appUser.email,
  name: appUser.name,
  role: appUser.role,
  deactivatedAt: appUser.deactivatedAt,
  createdAt: appUser.createdAt,
};

export const USER_NAME_MAX_LENGTH = 200;
export const DEACTIVATED_USER_NAME = "Deactivated user";

/** Unique, undeliverable placeholder that replaces a deactivated user's email (§6). */
export function deactivatedEmail(userId: string): string {
  return `deleted+${userId}@invalid`;
}

/** Users of the actor's org, active first, then by creation time. */
export async function listUsers(db: Db, ctx: AuthContext): Promise<OrgUser[]> {
  const rows = await withTenant(db, ctx, (tx) =>
    tx.select(columns).from(appUser).orderBy(asc(appUser.createdAt), asc(appUser.id)),
  );
  return [...rows.filter((u) => !u.deactivatedAt), ...rows.filter((u) => u.deactivatedAt)];
}

/** The actor's own user row (for the nav bar and account pages). */
export async function getCurrentUser(db: Db, ctx: AuthContext): Promise<OrgUser> {
  const [row] = await withTenant(db, ctx, (tx) => tx.select(columns).from(appUser).where(eq(appUser.id, ctx.userId)));
  if (!row) throw new NotFoundError();
  return row;
}

export interface InviteUserInput {
  db: Db;
  ctx: AuthContext;
  clock: () => Date;
  emailProvider: EmailProvider;
  /** Public base URL of the web app; the welcome email links to `${appUrl}/login`. */
  appUrl: string;
  email: string;
  name: string;
  role: UserRole;
}

/** Shown for any address that cannot be added (already a user here or in another org). */
export const INVITE_CONFLICT_MESSAGE = "That email address could not be added. Check it, or use a different address.";

/**
 * Invitation attempts per org (ARCHITECTURE §14). Conflicts count too: they bound how fast an
 * admin can probe whether addresses belong to users elsewhere (residual risk in DECISIONS.md).
 */
export const INVITE_RATE_LIMIT = { limit: 20, windowSeconds: 60 * 60 } as const;

/**
 * Admin only. Creates the user and audits `user.invite`, then sends a welcome email with
 * the login URL. The user exists even if delivery fails (`emailSent: false`); they can
 * request a sign-in link from the login page. At most `INVITE_RATE_LIMIT` attempts per org
 * (`RateLimitedError` beyond it).
 */
export async function inviteUser(input: InviteUserInput): Promise<{ user: OrgUser; emailSent: boolean }> {
  const { db, ctx, clock, emailProvider, appUrl, role } = input;
  requireAdmin(ctx);
  const email = normalizeEmail(input.email);
  if (!email) throw new ValidationError("Enter a valid email address.", "email");
  const name = input.name.trim();
  if (name.length === 0 || name.length > USER_NAME_MAX_LENGTH) {
    throw new ValidationError(`Name must be 1 to ${USER_NAME_MAX_LENGTH} characters.`, "name");
  }
  if (!(userRoles as readonly string[]).includes(role)) throw new ValidationError("Choose a role.", "role");
  const now = clock();
  const limit = await checkRateLimit(db, { scope: "user_invite_org", id: ctx.orgId, now, ...INVITE_RATE_LIMIT });
  if (!limit.allowed) throw new RateLimitedError(limit.retryAfterSeconds, "Too many invitations in this hour. Try again later.");

  let created: { user: OrgUser; orgName: string };
  try {
    created = await withTenant(db, ctx, async (tx) => {
      const [user] = await tx
        .insert(appUser)
        .values({ orgId: ctx.orgId, email, name, role, createdAt: now })
        .returning(columns);
      if (!user) throw new Error("inviteUser: insert returned no row");
      const [current] = await tx.select({ name: org.name }).from(org).where(eq(org.id, ctx.orgId));
      await writeAudit(tx, {
        orgId: ctx.orgId,
        actorUserId: ctx.userId,
        action: "user.invite",
        targetType: "user",
        targetId: user.id,
        metadata: { role },
        at: now,
      });
      return { user, orgName: current?.name ?? "your team" };
    });
  } catch (error) {
    if (getPgError(error)?.code === "23505") {
      // Emails are unique across all orgs; do not tell an admin that the address exists elsewhere.
      log.info("user.invite.conflict", { orgId: logId(ctx.orgId), code: "23505" as const });
      throw new ConflictError(INVITE_CONFLICT_MESSAGE);
    }
    throw error;
  }

  let emailSent = true;
  try {
    await emailProvider.send({
      to: email,
      subject: `You've been added to ${created.orgName} on Veradact`,
      text:
        `You've been added to ${created.orgName} on Veradact.\n\n` +
        `Sign in with this email address at:\n${appUrl.replace(/\/+$/, "")}/login\n\n` +
        "We'll email you a one-time sign-in link; there is no password.\n",
      tags: { kind: "user_invite" },
    });
  } catch (error) {
    emailSent = false;
    logError("user.invite.delivery_failed", error, { userId: logId(created.user.id) });
  }
  return { user: created.user, emailSent };
}

/**
 * Admin only; an admin cannot deactivate themselves. Sets `deactivated_at`, replaces name and
 * email with placeholders (§6: events reference user ids only), revokes every session and API
 * token, and audits `user.deactivate`. Idempotent for an already deactivated user.
 */
export async function deactivateUser(input: {
  db: Db;
  ctx: AuthContext;
  clock: () => Date;
  userId: string;
}): Promise<OrgUser> {
  const { db, ctx, clock, userId } = input;
  requireAdmin(ctx);
  if (userId === ctx.userId) throw new ForbiddenError("You can't deactivate your own account.");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) throw new NotFoundError();
  const now = clock();

  return withTenant(db, ctx, async (tx) => {
    const [target] = await tx.select(columns).from(appUser).where(eq(appUser.id, userId)).for("update");
    if (!target) throw new NotFoundError();
    if (target.deactivatedAt) return target;

    const [updated] = await tx
      .update(appUser)
      .set({ deactivatedAt: now, email: deactivatedEmail(userId), name: DEACTIVATED_USER_NAME })
      .where(eq(appUser.id, userId))
      .returning(columns);
    if (!updated) throw new NotFoundError();
    const sessions = await tx
      .update(session)
      .set({ revokedAt: now })
      .where(and(eq(session.userId, userId), isNull(session.revokedAt)))
      .returning({ id: session.id });
    const tokens = await tx
      .update(apiToken)
      .set({ revokedAt: now })
      .where(and(eq(apiToken.userId, userId), isNull(apiToken.revokedAt)))
      .returning({ id: apiToken.id });
    await writeAudit(tx, {
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      action: "user.deactivate",
      targetType: "user",
      targetId: userId,
      metadata: { sessions_revoked: sessions.length, api_tokens_revoked: tokens.length },
      at: now,
    });
    return updated;
  });
}
