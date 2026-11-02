import { sql } from "drizzle-orm";
import type { Db } from "./client";

/** A Drizzle transaction scoped to one tenant by withTenant(). */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface TenantContext {
  orgId: string;
  userId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` in a transaction whose RLS tenant is `orgId` (ARCHITECTURE §7). The settings are
 * transaction-local (`set_config(..., true)`), so they vanish on commit/rollback and never
 * leak to the next user of the pooled connection. All tenant data access goes through here.
 */
export async function withTenant<T>(
  db: Db,
  ctx: TenantContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!UUID.test(ctx.orgId)) throw new Error("withTenant: orgId must be a UUID");
  if (ctx.userId !== undefined && !UUID.test(ctx.userId)) {
    throw new Error("withTenant: userId must be a UUID");
  }
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.org_id', ${ctx.orgId}, true), set_config('app.user_id', ${ctx.userId ?? ""}, true)`,
    );
    return fn(tx);
  });
}
