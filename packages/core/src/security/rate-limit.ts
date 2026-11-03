// Fixed-window rate limiting in Postgres (ARCHITECTURE §14, D-017). One row per
// (key, window); `key` is the sha256 of scope + window length + identifier, so raw IPs,
// emails and tokens never reach the table. `rate_limit_bucket` has no tenant data and no tenant
// policy (RLS admits only the app role), so these run on the app-role Db outside withTenant.
import { sql } from "drizzle-orm";
import type { Queryable } from "@veradact/db";
import { hashToken } from "./tokens";

/** Limited surfaces. Append new scopes here. */
export type RateLimitScope =
  | "magic_link_ip"
  | "magic_link_email"
  | "magic_link_verify_ip"
  | "client_page_ip"
  | "client_page_link"
  | "mcp_token"
  | "mcp_ip"
  | "user_invite_org"
  | "signup_ip"
  | "signup_email"
  | "signup_complete_ip"
  | "demo_login_ip";

export interface RateLimitInput {
  scope: RateLimitScope;
  /** What is limited: an IP, a normalized email, a token id. Hashed before storage. */
  id: string;
  /** Requests allowed per window. */
  limit: number;
  windowSeconds: number;
  now: Date;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in the current window after this one. */
  remaining: number;
  /** 0 when allowed; otherwise seconds until the window resets. */
  retryAfterSeconds: number;
}

export function rateLimitKey(scope: RateLimitScope, windowSeconds: number, id: string): string {
  return hashToken(`${scope}:${windowSeconds}:${id}`);
}

/**
 * Counts this request against the current window and reports whether it is within the limit.
 * The upsert-increment is atomic, so concurrent requests on several instances each get a
 * distinct count. Requests over the limit still count (a client hammering the endpoint stays
 * blocked until the window ends).
 */
export async function checkRateLimit(db: Queryable, input: RateLimitInput): Promise<RateLimitResult> {
  const { scope, id, limit, windowSeconds, now } = input;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("checkRateLimit: limit must be a positive integer");
  if (!Number.isInteger(windowSeconds) || windowSeconds < 1) {
    throw new Error("checkRateLimit: windowSeconds must be a positive integer");
  }
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const rows = await db.execute<{ count: number }>(sql`
    insert into rate_limit_bucket (key, window_start, count)
    values (${rateLimitKey(scope, windowSeconds, id)}, ${windowStart}, 1)
    on conflict (key, window_start) do update set count = rate_limit_bucket.count + 1
    returning count`);
  const count = Number(rows[0]?.count ?? Number.MAX_SAFE_INTEGER);
  const allowed = count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: allowed
      ? 0
      : Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000)),
  };
}

/** Deletes windows that started before `before`. Returns the number of rows removed. */
export async function pruneRateLimitBuckets(db: Queryable, before: Date): Promise<number> {
  const result = await db.execute(sql`delete from rate_limit_bucket where window_start < ${before}`);
  return result.count;
}
