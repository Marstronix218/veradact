// Resolves the ids agents and URLs pass (ARCHITECTURE §11): engagements by UUID or short code
// (`HALV`), items by UUID or short id (`HALV-R7`). Lookups run in the caller's tenant transaction,
// so another org's ids resolve to null exactly like unknown ones.
import { eq } from "drizzle-orm";
import { engagement, item, type Tx } from "@veradact/db";

export type EngagementRecord = typeof engagement.$inferSelect;

export interface ItemRefResult {
  itemId: string;
  engagementId: string;
  shortId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_CODE = /^[A-Z0-9]{2,8}$/;
const SHORT_ID = /^[A-Z0-9]{2,8}-[PCADR][1-9][0-9]{0,8}$/;

/** Engagement by UUID or short code (case-insensitive), or null when unknown in this tenant. */
export async function resolveEngagementRef(tx: Tx, ref: string): Promise<EngagementRecord | null> {
  const value = ref.trim();
  let where;
  if (UUID.test(value)) where = eq(engagement.id, value.toLowerCase());
  else if (SHORT_CODE.test(value.toUpperCase())) where = eq(engagement.shortCode, value.toUpperCase());
  else return null;
  const [row] = await tx.select().from(engagement).where(where);
  return row ?? null;
}

/** Item by UUID or short id such as `HALV-R7` (case-insensitive), or null when unknown in this tenant. */
export async function resolveItemRef(tx: Tx, ref: string): Promise<ItemRefResult | null> {
  const value = ref.trim();
  let where;
  if (UUID.test(value)) where = eq(item.id, value.toLowerCase());
  else if (SHORT_ID.test(value.toUpperCase())) where = eq(item.shortId, value.toUpperCase());
  else return null;
  // Short codes are unique per org, so a short id names at most one item in the tenant.
  const rows = await tx.select({ itemId: item.id, engagementId: item.engagementId, shortId: item.shortId }).from(item).where(where).limit(2);
  return rows.length === 1 ? rows[0]! : null;
}
