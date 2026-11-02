// Loads the inputs of the pure pilot metrics (ARCHITECTURE §12, `domain/metrics.ts`) from the
// tenant's log, links and usage rows. Run inside withTenant; RLS scopes everything to the org.
import { asc, eq } from "drizzle-orm";
import { confirmationLink, engagement, event, usageEvent, type Tx } from "@veradact/db";
import { aggregateOrgMetrics, computeEngagementMetrics, metricsToCsv, type EngagementMetrics, type LinkStat, type OrgMetrics, type UsageStat } from "../domain";
import { toStoredEvent } from "../store";

export { seedMetricsScenario, type SeedMetricsScenarioInput, type SeededMetricsScenario } from "./seed-scenario";

type LinkRow = typeof confirmationLink.$inferSelect;
type UsageRow = typeof usageEvent.$inferSelect;

function linkStat(l: LinkRow): LinkStat {
  return {
    linkId: l.id,
    requestId: l.requestId,
    contactId: l.contactId,
    emailSentAt: l.emailSentAt,
    firstOpenedAt: l.firstOpenedAt,
    openCount: l.openCount,
    firstInteractionAt: l.firstInteractionAt,
    revokedAt: l.revokedAt,
  };
}

function usageStat(u: UsageRow): UsageStat {
  return { kind: u.kind, createdAt: u.createdAt };
}

/** Metrics of one engagement as of `now`, or null when it does not exist in this tenant. */
export async function loadEngagementMetrics(tx: Tx, engagementId: string, now: Date): Promise<EngagementMetrics | null> {
  const [eng] = await tx.select().from(engagement).where(eq(engagement.id, engagementId));
  if (!eng) return null;
  const [events, links, usage] = await Promise.all([
    tx.select().from(event).where(eq(event.engagementId, engagementId)).orderBy(asc(event.seq)),
    tx.select().from(confirmationLink).where(eq(confirmationLink.engagementId, engagementId)),
    tx.select().from(usageEvent).where(eq(usageEvent.engagementId, engagementId)),
  ]);
  return computeEngagementMetrics({
    engagementId: eng.id,
    shortCode: eng.shortCode,
    name: eng.name,
    timeZone: eng.timeZone,
    events: events.map(toStoredEvent),
    links: links.map(linkStat),
    usage: usage.map(usageStat),
    now,
  });
}

export interface OrgMetricsView {
  org: OrgMetrics;
  /** Every engagement of the org (active first, then by name). */
  engagements: (EngagementMetrics & { status: "active" | "archived" })[];
}

/** Metrics of every engagement in the tenant plus org totals, as of `now` (three queries). */
export async function loadOrgMetrics(tx: Tx, now: Date): Promise<OrgMetricsView> {
  const [engagements, events, links, usage] = await Promise.all([
    tx.select().from(engagement).orderBy(asc(engagement.status), asc(engagement.name)),
    tx.select().from(event).orderBy(asc(event.engagementId), asc(event.seq)),
    tx.select().from(confirmationLink),
    tx.select().from(usageEvent),
  ]);
  const group = <T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> => {
    const out = new Map<K, T[]>();
    for (const row of rows) {
      const list = out.get(key(row));
      if (list) list.push(row);
      else out.set(key(row), [row]);
    }
    return out;
  };
  const eventsBy = group(events, (e) => e.engagementId);
  const linksBy = group(links, (l) => l.engagementId);
  const usageBy = group(usage, (u) => u.engagementId);

  const per = engagements.map((eng) => ({
    ...computeEngagementMetrics({
      engagementId: eng.id,
      shortCode: eng.shortCode,
      name: eng.name,
      timeZone: eng.timeZone,
      events: (eventsBy.get(eng.id) ?? []).map(toStoredEvent),
      links: (linksBy.get(eng.id) ?? []).map(linkStat),
      usage: (usageBy.get(eng.id) ?? []).map(usageStat),
      now,
    }),
    status: eng.status,
  }));
  return { org: aggregateOrgMetrics(per), engagements: per };
}

/** The `/api/metrics.csv` download: one row per engagement plus the org total (D-043). */
export async function buildMetricsCsv(tx: Tx, now: Date): Promise<{ filename: string; body: string }> {
  const view = await loadOrgMetrics(tx, now);
  return { filename: `veradact-metrics-${now.toISOString().slice(0, 10)}.csv`, body: metricsToCsv(view.org, view.engagements) };
}
