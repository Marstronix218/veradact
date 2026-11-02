// Shared plumbing for ledger commands (ARCHITECTURE §5.2). Every command runs inside withTenant —
// its own transaction (`db`) or the caller's (`tx`, e.g. when extraction accepts a candidate and
// updates the candidate row in the same transaction) — takes the engagement lock, folds the log,
// validates, and only then produces drafts.
import { sql } from "drizzle-orm";
import { withTenant, type Db, type Tx } from "@veradact/db";
import type { Actor, EngagementInfo, EngagementState } from "../domain";
import { DomainError } from "../errors";
import { loadState, lockEngagement } from "../store";

/** Exactly one of `db` (the command opens its own tenant transaction) or `tx` (already scoped). */
export type TenantHandle = { db: Db; tx?: undefined } | { tx: Tx; db?: undefined };

interface ContextBase {
  orgId: string;
  /** Application clock (system clock in production, a stepping fake clock in tests and seed). */
  clock: () => Date;
}

/** A vendor member acting through the app or an API. */
export type CommandContext = TenantHandle & ContextBase & { userId: string };

/** A client contact acting through a confirmation channel; the actor is the contact. */
export type ClientCommandContext = TenantHandle & ContextBase;

/** Commands a job may also run: `userId: null` records the `system` actor. */
export type UserOrSystemContext = TenantHandle & ContextBase & { userId: string | null };

/**
 * Runs `fn` in the tenant transaction. A caller-supplied `tx` must already be scoped to
 * `ctx.orgId` by withTenant (checked), so commands never run outside RLS.
 */
export async function runInTenant<T>(
  ctx: TenantHandle & { orgId: string; userId?: string | null },
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (ctx.tx) {
    const [row] = await ctx.tx.execute<{ org_id: string | null }>(sql`select current_setting('app.org_id', true) as org_id`);
    if (row?.org_id !== ctx.orgId) throw new Error("command: the transaction is not scoped to this org");
    return fn(ctx.tx);
  }
  return withTenant(ctx.db, ctx.userId ? { orgId: ctx.orgId, userId: ctx.userId } : { orgId: ctx.orgId }, fn);
}

export function userActor(userId: string): Actor {
  return { type: "user", id: userId };
}

export function userOrSystemActor(userId: string | null): Actor {
  return userId === null ? { type: "system", id: null } : { type: "user", id: userId };
}

export interface LockedState {
  state: EngagementState;
  engagement: EngagementInfo;
}

/**
 * Takes the engagement's append lock for the rest of the transaction and folds its log. Throws
 * `engagement_not_found` when the engagement has no visible log (unknown id or another tenant).
 */
export async function lockAndLoad(tx: Tx, engagementId: string): Promise<LockedState> {
  await lockEngagement(tx, engagementId);
  const state = await loadState(tx, engagementId);
  if (!state.engagement || state.engagement.id !== engagementId) throw new DomainError("engagement_not_found");
  return { state, engagement: state.engagement };
}

/** A clock that always returns `now` (one clock read per command; batches share a millisecond). */
export function fixedClock(now: Date): () => Date {
  return () => new Date(now.getTime());
}
