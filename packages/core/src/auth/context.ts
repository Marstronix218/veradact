import type { UserRole } from "@veradact/db";
import { ForbiddenError } from "../errors";

export type { UserRole };

/** Who is acting, resolved from a session cookie or an API token. */
export interface AuthContext {
  orgId: string;
  userId: string;
  role: UserRole;
}

export function isAdmin(ctx: AuthContext): boolean {
  return ctx.role === "admin";
}

/** Throws `ForbiddenError` unless the actor is an org admin (ARCHITECTURE §14). */
export function requireAdmin(ctx: AuthContext): void {
  if (!isAdmin(ctx)) throw new ForbiddenError("Only an admin can do that.");
}
