// Typed wrappers for the pre-tenant SECURITY DEFINER functions (migration 0004).
// Call them with the app-role Db (outside withTenant) or inside a Tx.
import { sql } from "drizzle-orm";
import type { Db } from "./client";
import type { UserRole } from "./schema";
import type { Tx } from "./tenant";

export type Queryable = Db | Tx;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface UserRef {
  userId: string;
  orgId: string;
}

export interface ConsumedLoginToken extends UserRef {
  loginTokenId: string;
}

export interface ResolvedSession extends UserRef {
  sessionId: string;
  role: UserRole;
  expiresAt: Date;
}

export interface ResolvedApiToken extends UserRef {
  apiTokenId: string;
  role: UserRole;
}

/** Returned even when expired or revoked; the caller decides validity. */
export interface ResolvedLink {
  linkId: string;
  orgId: string;
  engagementId: string;
  requestId: string;
  contactId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** Active (not deactivated) user with this email, case-insensitive. */
export async function authFindUserByEmail(q: Queryable, email: string): Promise<UserRef | null> {
  const rows = await q.execute<{ user_id: string; org_id: string }>(
    sql`select user_id, org_id from auth_find_user_by_email(${email})`,
  );
  const row = rows[0];
  return row ? { userId: row.user_id, orgId: row.org_id } : null;
}

/** Marks an unexpired, unused login token used and returns its user; null otherwise. Single use. */
export async function authConsumeLoginToken(
  q: Queryable,
  tokenHash: string,
): Promise<ConsumedLoginToken | null> {
  const rows = await q.execute<{ login_token_id: string; user_id: string; org_id: string }>(
    sql`select login_token_id, user_id, org_id from auth_consume_login_token(${tokenHash})`,
  );
  const row = rows[0];
  return row ? { loginTokenId: row.login_token_id, userId: row.user_id, orgId: row.org_id } : null;
}

/** Live session (not revoked, not expired, user active) for a session token hash. */
export async function authResolveSession(
  q: Queryable,
  tokenHash: string,
): Promise<ResolvedSession | null> {
  const rows = await q.execute<{
    session_id: string;
    user_id: string;
    org_id: string;
    role: UserRole;
    expires_at: Date;
  }>(
    sql`select session_id, user_id, org_id, role, expires_at from auth_resolve_session(${tokenHash})`,
  );
  const row = rows[0];
  return row
    ? {
        sessionId: row.session_id,
        userId: row.user_id,
        orgId: row.org_id,
        role: row.role,
        expiresAt: row.expires_at,
      }
    : null;
}

/** Live API token (not revoked, user active) for a token hash. */
export async function authResolveApiToken(
  q: Queryable,
  tokenHash: string,
): Promise<ResolvedApiToken | null> {
  const rows = await q.execute<{ api_token_id: string; user_id: string; org_id: string; role: UserRole }>(
    sql`select api_token_id, user_id, org_id, role from auth_resolve_api_token(${tokenHash})`,
  );
  const row = rows[0];
  return row
    ? { apiTokenId: row.api_token_id, userId: row.user_id, orgId: row.org_id, role: row.role }
    : null;
}

/** Tenant and binding of a confirmation link. Null for unknown or malformed ids. */
export async function linkResolve(q: Queryable, linkId: string): Promise<ResolvedLink | null> {
  if (!UUID.test(linkId)) return null;
  const rows = await q.execute<{
    link_id: string;
    org_id: string;
    engagement_id: string;
    request_id: string;
    contact_id: string;
    expires_at: Date;
    revoked_at: Date | null;
  }>(
    sql`select link_id, org_id, engagement_id, request_id, contact_id, expires_at, revoked_at
        from link_resolve(${linkId}::uuid)`,
  );
  const row = rows[0];
  return row
    ? {
        linkId: row.link_id,
        orgId: row.org_id,
        engagementId: row.engagement_id,
        requestId: row.request_id,
        contactId: row.contact_id,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
      }
    : null;
}

/** Every org id, for jobs that then work per org inside withTenant(). */
export async function jobsListOrgIds(q: Queryable): Promise<string[]> {
  const rows = await q.execute<{ org_id: string }>(
    sql`select org_id from jobs_list_org_ids() as t(org_id)`,
  );
  return rows.map((row) => row.org_id);
}

export interface SignupOrgInput {
  orgId: string;
  orgName: string;
  slug: string;
  userId: string;
  email: string;
  userName: string;
  createdAt: Date;
}

/**
 * Creates an org (AI off) and its first admin in one statement (D-062). Null when the email or
 * slug is already taken; nothing is created then.
 */
export async function signupCreateOrg(q: Queryable, input: SignupOrgInput): Promise<UserRef | null> {
  const rows = await q.execute<{ org_id: string; user_id: string }>(
    sql`select org_id, user_id from signup_create_org(
          ${input.orgId}::uuid, ${input.orgName}, ${input.slug},
          ${input.userId}::uuid, ${input.email}, ${input.userName}, ${input.createdAt})`,
  );
  const row = rows[0];
  return row ? { userId: row.user_id, orgId: row.org_id } : null;
}
