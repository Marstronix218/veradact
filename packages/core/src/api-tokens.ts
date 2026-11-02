// Per-user API tokens for the MCP server (ARCHITECTURE §2.1, §11). The raw `vdt_<base64url>`
// value is shown once at creation; the database keeps a display prefix and the sha256.
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { apiToken, appUser, authResolveApiToken, withTenant, type Db, type UserRole } from "@veradact/db";
import { writeAudit } from "./audit";
import { isAdmin, type AuthContext } from "./auth/context";
import { NotFoundError, ValidationError } from "./errors";
import { hashToken, randomToken } from "./security/tokens";

export const API_TOKEN_PREFIX = "vdt_";
/** `vdt_` + the first 8 token characters: enough to tell tokens apart, far too little to guess. */
const DISPLAY_PREFIX_LENGTH = API_TOKEN_PREFIX.length + 8;
const RAW_API_TOKEN = /^vdt_[A-Za-z0-9_-]{43}$/;
export const API_TOKEN_NAME_MAX_LENGTH = 100;
/** `last_used_at` is written at most this often per token. */
export const API_TOKEN_TOUCH_INTERVAL_MS = 60 * 1000;

export interface ApiTokenSummary {
  id: string;
  name: string;
  tokenPrefix: string;
  userId: string;
  /** Owner's email (admins see every token in the org). */
  userEmail: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface CreatedApiToken {
  id: string;
  name: string;
  tokenPrefix: string;
  /** The only time the raw token is available. Never stored or logged. */
  token: string;
  createdAt: Date;
}

export interface ResolvedApiTokenAuth extends AuthContext {
  apiTokenId: string;
}

/** Creates a token owned by the actor and audits `api_token.create`. */
export async function createApiToken(input: {
  db: Db;
  ctx: AuthContext;
  clock: () => Date;
  name: string;
}): Promise<CreatedApiToken> {
  const { db, ctx, clock } = input;
  const name = input.name.trim();
  if (name.length === 0 || name.length > API_TOKEN_NAME_MAX_LENGTH) {
    throw new ValidationError(`Token name must be 1 to ${API_TOKEN_NAME_MAX_LENGTH} characters.`, "name");
  }
  const token = `${API_TOKEN_PREFIX}${randomToken()}`;
  const tokenPrefix = token.slice(0, DISPLAY_PREFIX_LENGTH);
  const now = clock();

  return withTenant(db, ctx, async (tx) => {
    const [row] = await tx
      .insert(apiToken)
      .values({ orgId: ctx.orgId, userId: ctx.userId, name, tokenPrefix, tokenHash: hashToken(token), createdAt: now })
      .returning({ id: apiToken.id });
    if (!row) throw new Error("createApiToken: insert returned no row");
    await writeAudit(tx, {
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      action: "api_token.create",
      targetType: "api_token",
      targetId: row.id,
      at: now,
    });
    return { id: row.id, name, tokenPrefix, token, createdAt: now };
  });
}

/** The actor's own tokens; admins see every token in the org. Newest first, revoked included. */
export async function listApiTokens(db: Db, ctx: AuthContext): Promise<ApiTokenSummary[]> {
  return withTenant(db, ctx, (tx) =>
    tx
      .select({
        id: apiToken.id,
        name: apiToken.name,
        tokenPrefix: apiToken.tokenPrefix,
        userId: apiToken.userId,
        userEmail: appUser.email,
        lastUsedAt: apiToken.lastUsedAt,
        revokedAt: apiToken.revokedAt,
        createdAt: apiToken.createdAt,
      })
      .from(apiToken)
      .innerJoin(appUser, and(eq(appUser.id, apiToken.userId), eq(appUser.orgId, apiToken.orgId)))
      .where(isAdmin(ctx) ? undefined : eq(apiToken.userId, ctx.userId))
      .orderBy(desc(apiToken.createdAt), desc(apiToken.id)),
  );
}

/**
 * Revokes one of the actor's tokens (admins: any token in the org) and audits
 * `api_token.revoke`. Revoking an already revoked token is a no-op.
 */
export async function revokeApiToken(input: {
  db: Db;
  ctx: AuthContext;
  clock: () => Date;
  tokenId: string;
}): Promise<void> {
  const { db, ctx, clock, tokenId } = input;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tokenId)) throw new NotFoundError();
  const now = clock();

  await withTenant(db, ctx, async (tx) => {
    const [token] = await tx
      .select({ id: apiToken.id, userId: apiToken.userId, revokedAt: apiToken.revokedAt })
      .from(apiToken)
      .where(eq(apiToken.id, tokenId))
      .for("update");
    // Members cannot tell other users' tokens from missing ones.
    if (!token || (!isAdmin(ctx) && token.userId !== ctx.userId)) throw new NotFoundError();
    if (token.revokedAt) return;
    await tx.update(apiToken).set({ revokedAt: now }).where(eq(apiToken.id, tokenId));
    await writeAudit(tx, {
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      action: "api_token.revoke",
      targetType: "api_token",
      targetId: tokenId,
      at: now,
    });
  });
}

/**
 * Bearer token → org, user and role (via the `auth_resolve_api_token` definer), or null for
 * malformed, unknown, revoked and deactivated-user tokens. Refreshes `last_used_at` at most
 * once per `API_TOKEN_TOUCH_INTERVAL_MS`.
 */
export async function resolveApiToken(
  db: Db,
  raw: string | null | undefined,
  clock: () => Date,
): Promise<ResolvedApiTokenAuth | null> {
  if (!raw || !RAW_API_TOKEN.test(raw)) return null;
  const resolved = await authResolveApiToken(db, hashToken(raw));
  if (!resolved) return null;

  const now = clock();
  const staleBefore = new Date(now.getTime() - API_TOKEN_TOUCH_INTERVAL_MS);
  await withTenant(db, { orgId: resolved.orgId, userId: resolved.userId }, (tx) =>
    tx
      .update(apiToken)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(apiToken.id, resolved.apiTokenId),
          or(isNull(apiToken.lastUsedAt), lt(apiToken.lastUsedAt, staleBefore)),
        ),
      ),
  );
  const role: UserRole = resolved.role;
  return { apiTokenId: resolved.apiTokenId, orgId: resolved.orgId, userId: resolved.userId, role };
}
