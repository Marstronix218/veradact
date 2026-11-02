// Engagement read helpers: list and summary counts for the engagement list and dashboard.
import { asc, eq } from "drizzle-orm";
import { clientContact, confirmationRequest, engagement, item, source, type EngagementStatus, type Tx } from "@veradact/db";
import { KINDS, type ItemStatus, type Kind } from "../domain";
import { readEngagementHead } from "../store";

export interface EngagementRow {
  id: string;
  name: string;
  clientName: string;
  shortCode: string;
  timeZone: string;
  aiEnabled: boolean;
  status: EngagementStatus;
  createdBy: string;
  createdAt: Date;
  archivedAt: Date | null;
}

export async function listEngagements(tx: Tx, options: { status?: EngagementStatus } = {}): Promise<EngagementRow[]> {
  const query = tx.select().from(engagement);
  const rows = await (options.status ? query.where(eq(engagement.status, options.status)) : query).orderBy(asc(engagement.name), asc(engagement.id));
  return rows.map(({ orgId: _orgId, ...r }) => r);
}

export interface EngagementSummary {
  engagement: EngagementRow;
  head: { seq: number; hash: string; recordedAt: Date } | null;
  items: {
    total: number;
    /** Active items per status. */
    byStatus: Record<ItemStatus, number>;
    /** Active items per kind. */
    byKind: Record<Kind, number>;
    needsReview: number;
    active: number;
    superseded: number;
    withdrawn: number;
  };
  sources: { total: number; redacted: number };
  contacts: { total: number; erased: number };
  requests: { total: number };
}

export async function getEngagementSummary(tx: Tx, engagementId: string): Promise<EngagementSummary | null> {
  const [row] = await tx.select().from(engagement).where(eq(engagement.id, engagementId));
  if (!row) return null;
  const [items, sources, contacts, requests, head] = await Promise.all([
    tx.select({ kind: item.kind, status: item.status, lifecycle: item.lifecycle, needsReview: item.needsReview }).from(item).where(eq(item.engagementId, engagementId)),
    tx.select({ redactedAt: source.redactedAt }).from(source).where(eq(source.engagementId, engagementId)),
    tx.select({ erasedAt: clientContact.erasedAt }).from(clientContact).where(eq(clientContact.engagementId, engagementId)),
    tx.select({ id: confirmationRequest.id }).from(confirmationRequest).where(eq(confirmationRequest.engagementId, engagementId)),
    readEngagementHead(tx, engagementId),
  ]);
  const active = items.filter((i) => i.lifecycle === "active");
  const byStatus: Record<ItemStatus, number> = { pending: 0, confirmed: 0, disputed: 0 };
  const byKind = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<Kind, number>;
  for (const i of active) {
    byStatus[i.status] += 1;
    byKind[i.kind] += 1;
  }
  const { orgId: _orgId, ...engagementRow } = row;
  return {
    engagement: engagementRow,
    head,
    items: {
      total: items.length,
      byStatus,
      byKind,
      needsReview: active.filter((i) => i.needsReview).length,
      active: active.length,
      superseded: items.filter((i) => i.lifecycle === "superseded").length,
      withdrawn: items.filter((i) => i.lifecycle === "withdrawn").length,
    },
    sources: { total: sources.length, redacted: sources.filter((s) => s.redactedAt !== null).length },
    contacts: { total: contacts.length, erased: contacts.filter((c) => c.erasedAt !== null).length },
    requests: { total: requests.length },
  };
}
