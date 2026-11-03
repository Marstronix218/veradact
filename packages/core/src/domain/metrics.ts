/**
 * Pilot metrics (ARCHITECTURE §12, DECISIONS D-022, D-028), pure over the event log plus link and
 * usage snapshots. Time is a parameter: everything is evaluated as of `now`, so events, link
 * timestamps and usage rows after `now` are ignored.
 *
 * Unit: an item version (item_id, version, content_hash) included in ≥ 1 `confirmation_requested`.
 * `sent_at` is the `recorded_at` of the first request including it and
 * `window_end = addBusinessDays(sent_at, 5, timeZone)`.
 * - Pulled: the item was revised, withdrawn or superseded before `window_end` with no client
 *   response (confirm or dispute) to that version before the pull. Pulled versions are neither
 *   matured nor maturing.
 * - Matured: not pulled and `window_end <= now`; maturing: not pulled and `window_end > now`.
 * - Confirmation rate = matured versions with an `item_confirmed` recorded at or before
 *   `window_end` ÷ matured versions.
 * - Time to confirm: `sent_at` → first `item_confirmed` of that version, whenever it came.
 * - Dispute rate = sent versions with ≥ 1 `item_disputed` ÷ all sent versions.
 * - Link engagement = sent links with a first interaction (POST) ÷ sent links; raw opens apart.
 * - Churn = `item_revised` events on items that had an `item_confirmed` before the revision.
 *
 * Every summary carries its raw counts and confirmation durations, so org totals recompute rates
 * from summed numerators/denominators and the median from pooled samples.
 */
import { addBusinessDays } from "./business-days";
import type { Kind, StoredEvent } from "./events";
import { fold } from "./reducer";
import type { ItemStatus } from "./state";

export const CONFIRMATION_WINDOW_BUSINESS_DAYS = 5;

export type UsageKind = "spec_export" | "record_export_md" | "record_export_pdf" | "mcp_fetch";

/** One `confirmation_link` row (operational table, ARCHITECTURE §2.4). */
export interface LinkStat {
  linkId: string;
  requestId: string;
  contactId: string;
  emailSentAt: Date | null;
  firstOpenedAt: Date | null;
  openCount: number;
  firstInteractionAt: Date | null;
  revokedAt: Date | null;
}

/** One `usage_event` row. */
export interface UsageStat {
  kind: UsageKind;
  createdAt: Date;
}

export interface EngagementMetricsInput {
  engagementId: string;
  shortCode: string;
  name: string;
  /** The engagement's current IANA time zone. */
  timeZone: string;
  /** The engagement's log from seq 1. */
  events: readonly StoredEvent[];
  links: readonly LinkStat[];
  usage: readonly UsageStat[];
  now: Date;
}

export type RateBand = "on_target" | "watch" | "kill_signal" | "insufficient_data";

/** Raw counts; summing two of these field by field gives the counts of the union. */
export interface MetricCounts {
  /** Item versions included in ≥ 1 confirmation request (= matured + maturing + pulled). */
  versionsSent: number;
  versionsMatured: number;
  versionsMaturing: number;
  versionsPulled: number;
  /** Matured versions with an `item_confirmed` recorded at or before `window_end`. */
  versionsConfirmedInWindow: number;
  versionsDisputed: number;
  /** Links whose email was sent. */
  linksSent: number;
  /** Sent links with a first interaction (any POST). */
  linksInteracted: number;
  /** Sent links opened at least once (raw GETs, inflated by mail scanners). */
  linksOpened: number;
  /** Total raw opens over sent links. */
  openCount: number;
  /** Revisions of items that had an `item_confirmed` before the revision, all kinds. */
  churnRevisions: number;
  churnRequirementRevisions: number;
  specExports: number;
  /** Markdown + PDF record exports. */
  recordExports: number;
  mcpFetches: number;
  /** All items, any lifecycle, at `now`. */
  itemsTotal: number;
  itemsActivePending: number;
  itemsActiveConfirmed: number;
  itemsActiveDisputed: number;
  confirmationRequests: number;
  /** `sent_at` → first `item_confirmed` per confirmed version, in ms, ascending. */
  confirmDurationsMs: readonly number[];
}

export interface MetricsSummary extends MetricCounts {
  /** versionsConfirmedInWindow ÷ versionsMatured; null when nothing has matured. */
  confirmationRate: number | null;
  rateBand: RateBand;
  /** Median of `confirmDurationsMs` in hours, rounded to 1 decimal; null without samples. */
  medianHoursToConfirm: number | null;
  timeToConfirmSamples: number;
  /** versionsDisputed ÷ versionsSent. */
  disputeRate: number | null;
  /** linksInteracted ÷ linksSent (the headline link metric, D-028). */
  linkEngagementRate: number | null;
  /** linksOpened ÷ linksSent. */
  linkOpenRate: number | null;
}

export interface EngagementMetrics extends MetricsSummary {
  engagementId: string;
  shortCode: string;
  name: string;
  timeZone: string;
  now: Date;
}

export interface OrgMetrics extends MetricsSummary {
  engagementCount: number;
}

/** The 5-business-day confirmation rate at or above which a pilot is on target. */
export const RATE_TARGET = 0.5;
/** Below this rate the pilot shows the kill signal. */
export const RATE_KILL = 0.25;

/** Bands for the 5-business-day confirmation rate: ≥ 50% on target, 25–50% watch, < 25% kill. */
export function rateBand(rate: number | null): RateBand {
  if (rate === null) return "insufficient_data";
  if (rate >= RATE_TARGET) return "on_target";
  if (rate >= RATE_KILL) return "watch";
  return "kill_signal";
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function medianHours(sortedMs: readonly number[]): number | null {
  const n = sortedMs.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  const ms = n % 2 === 1 ? sortedMs[mid]! : (sortedMs[mid - 1]! + sortedMs[mid]!) / 2;
  return Math.round(ms / 360_000) / 10;
}

function summarize(counts: MetricCounts): MetricsSummary {
  const confirmationRate = ratio(counts.versionsConfirmedInWindow, counts.versionsMatured);
  return {
    ...counts,
    confirmationRate,
    rateBand: rateBand(confirmationRate),
    medianHoursToConfirm: medianHours(counts.confirmDurationsMs),
    timeToConfirmSamples: counts.confirmDurationsMs.length,
    disputeRate: ratio(counts.versionsDisputed, counts.versionsSent),
    linkEngagementRate: ratio(counts.linksInteracted, counts.linksSent),
    linkOpenRate: ratio(counts.linksOpened, counts.linksSent),
  };
}

interface SentVersion {
  sentAt: Date;
  windowEnd: Date;
  firstResponseSeq: number | null;
  firstConfirmedAt: Date | null;
  disputed: boolean;
  /** First revise/withdraw/supersede of the item after this version was sent. */
  endedBy: { seq: number; at: Date } | null;
}

const versionKey = (itemId: string, version: number, contentHash: string) => `${itemId}:${version}:${contentHash}`;

function isAtOrBefore(t: Date | null, limit: Date): boolean {
  return t !== null && t.getTime() <= limit.getTime();
}

export function computeEngagementMetrics(input: EngagementMetricsInput): EngagementMetrics {
  const { now, timeZone } = input;
  const events = input.events.filter((e) => e.recordedAt.getTime() <= now.getTime()).sort((a, b) => a.seq - b.seq);

  const versions = new Map<string, SentVersion>();
  const versionsByItem = new Map<string, SentVersion[]>();
  const kinds = new Map<string, Kind>();
  const itemsWithConfirmation = new Set<string>();
  let churnRevisions = 0;
  let churnRequirementRevisions = 0;

  for (const e of events) {
    switch (e.type) {
      case "item_created":
        if (!kinds.has(e.payload.item_id)) kinds.set(e.payload.item_id, e.payload.kind);
        break;
      case "confirmation_requested":
        for (const i of e.payload.items) {
          const key = versionKey(i.item_id, i.version, i.content_hash);
          if (versions.has(key)) continue;
          const sent: SentVersion = {
            sentAt: e.recordedAt,
            windowEnd: addBusinessDays(e.recordedAt, CONFIRMATION_WINDOW_BUSINESS_DAYS, timeZone),
            firstResponseSeq: null,
            firstConfirmedAt: null,
            disputed: false,
            endedBy: null,
          };
          versions.set(key, sent);
          versionsByItem.set(i.item_id, [...(versionsByItem.get(i.item_id) ?? []), sent]);
        }
        break;
      case "item_confirmed":
      case "item_disputed": {
        const p = e.payload;
        if (e.type === "item_confirmed") itemsWithConfirmation.add(p.item_id);
        const sent = versions.get(versionKey(p.item_id, p.version, p.content_hash));
        if (!sent) break;
        sent.firstResponseSeq ??= e.seq;
        if (e.type === "item_confirmed") sent.firstConfirmedAt ??= e.recordedAt;
        else sent.disputed = true;
        break;
      }
      case "item_revised":
      case "item_withdrawn":
      case "item_superseded": {
        const itemId = e.payload.item_id;
        for (const sent of versionsByItem.get(itemId) ?? []) sent.endedBy ??= { seq: e.seq, at: e.recordedAt };
        if (e.type === "item_revised" && itemsWithConfirmation.has(itemId)) {
          churnRevisions++;
          if (kinds.get(itemId) === "requirement") churnRequirementRevisions++;
        }
        break;
      }
      default:
        break;
    }
  }

  let versionsMatured = 0;
  let versionsMaturing = 0;
  let versionsPulled = 0;
  let versionsConfirmedInWindow = 0;
  let versionsDisputed = 0;
  const confirmDurationsMs: number[] = [];
  for (const v of versions.values()) {
    const pulled =
      v.endedBy !== null &&
      v.endedBy.at.getTime() < v.windowEnd.getTime() &&
      (v.firstResponseSeq === null || v.firstResponseSeq > v.endedBy.seq);
    if (pulled) versionsPulled++;
    else if (v.windowEnd.getTime() <= now.getTime()) {
      versionsMatured++;
      if (isAtOrBefore(v.firstConfirmedAt, v.windowEnd)) versionsConfirmedInWindow++;
    } else versionsMaturing++;
    if (v.disputed) versionsDisputed++;
    if (v.firstConfirmedAt) confirmDurationsMs.push(v.firstConfirmedAt.getTime() - v.sentAt.getTime());
  }
  confirmDurationsMs.sort((a, b) => a - b);

  const sentLinks = input.links.filter((l) => isAtOrBefore(l.emailSentAt, now));
  const usage = input.usage.filter((u) => u.createdAt.getTime() <= now.getTime());
  const usageCount = (...wanted: UsageKind[]) => usage.filter((u) => wanted.includes(u.kind)).length;

  const state = fold(events);
  const active = [...state.items.values()].filter((i) => i.lifecycle === "active");
  const activeWithStatus = (status: ItemStatus) => active.filter((i) => i.status === status).length;

  return {
    engagementId: input.engagementId,
    shortCode: input.shortCode,
    name: input.name,
    timeZone,
    now,
    ...summarize({
      versionsSent: versions.size,
      versionsMatured,
      versionsMaturing,
      versionsPulled,
      versionsConfirmedInWindow,
      versionsDisputed,
      linksSent: sentLinks.length,
      linksInteracted: sentLinks.filter((l) => isAtOrBefore(l.firstInteractionAt, now)).length,
      linksOpened: sentLinks.filter((l) => isAtOrBefore(l.firstOpenedAt, now)).length,
      openCount: sentLinks.reduce((sum, l) => sum + l.openCount, 0),
      churnRevisions,
      churnRequirementRevisions,
      specExports: usageCount("spec_export"),
      recordExports: usageCount("record_export_md", "record_export_pdf"),
      mcpFetches: usageCount("mcp_fetch"),
      itemsTotal: state.items.size,
      itemsActivePending: activeWithStatus("pending"),
      itemsActiveConfirmed: activeWithStatus("confirmed"),
      itemsActiveDisputed: activeWithStatus("disputed"),
      confirmationRequests: state.requests.size,
      confirmDurationsMs,
    }),
  };
}

/** Org totals: counts summed, rates recomputed from the sums, median over the pooled samples. */
export function aggregateOrgMetrics(perEngagement: readonly EngagementMetrics[]): OrgMetrics {
  const totals: Omit<MetricCounts, "confirmDurationsMs"> = {
    versionsSent: 0,
    versionsMatured: 0,
    versionsMaturing: 0,
    versionsPulled: 0,
    versionsConfirmedInWindow: 0,
    versionsDisputed: 0,
    linksSent: 0,
    linksInteracted: 0,
    linksOpened: 0,
    openCount: 0,
    churnRevisions: 0,
    churnRequirementRevisions: 0,
    specExports: 0,
    recordExports: 0,
    mcpFetches: 0,
    itemsTotal: 0,
    itemsActivePending: 0,
    itemsActiveConfirmed: 0,
    itemsActiveDisputed: 0,
    confirmationRequests: 0,
  };
  const keys = Object.keys(totals) as (keyof typeof totals)[];
  for (const m of perEngagement) for (const key of keys) totals[key] += m[key];
  const confirmDurationsMs = perEngagement.flatMap((m) => m.confirmDurationsMs).sort((a, b) => a - b);
  return { engagementCount: perEngagement.length, ...summarize({ ...totals, confirmDurationsMs }) };
}

// ---------------------------------------------------------------------------------------------
// CSV

type Cell = string | number | null;

const CSV_COLUMNS: readonly { header: string; cell: (m: MetricsSummary) => Cell }[] = [
  { header: "versions_sent", cell: (m) => m.versionsSent },
  { header: "versions_matured", cell: (m) => m.versionsMatured },
  { header: "versions_maturing", cell: (m) => m.versionsMaturing },
  { header: "versions_pulled", cell: (m) => m.versionsPulled },
  { header: "versions_confirmed_within_5_business_days", cell: (m) => m.versionsConfirmedInWindow },
  { header: "confirmation_rate_5_business_days", cell: (m) => rateCell(m.confirmationRate) },
  { header: "confirmation_rate_band", cell: (m) => m.rateBand },
  { header: "median_hours_to_confirm", cell: (m) => m.medianHoursToConfirm },
  { header: "time_to_confirm_samples", cell: (m) => m.timeToConfirmSamples },
  { header: "versions_disputed", cell: (m) => m.versionsDisputed },
  { header: "dispute_rate", cell: (m) => rateCell(m.disputeRate) },
  { header: "links_sent", cell: (m) => m.linksSent },
  { header: "links_interacted", cell: (m) => m.linksInteracted },
  { header: "link_engagement_rate", cell: (m) => rateCell(m.linkEngagementRate) },
  { header: "links_opened_raw", cell: (m) => m.linksOpened },
  { header: "link_open_rate_raw", cell: (m) => rateCell(m.linkOpenRate) },
  { header: "open_count_raw", cell: (m) => m.openCount },
  { header: "churn_revisions_all_kinds", cell: (m) => m.churnRevisions },
  { header: "churn_revisions_requirements", cell: (m) => m.churnRequirementRevisions },
  { header: "spec_exports", cell: (m) => m.specExports },
  { header: "record_exports", cell: (m) => m.recordExports },
  { header: "mcp_fetches", cell: (m) => m.mcpFetches },
  { header: "items_total", cell: (m) => m.itemsTotal },
  { header: "items_active_pending", cell: (m) => m.itemsActivePending },
  { header: "items_active_confirmed", cell: (m) => m.itemsActiveConfirmed },
  { header: "items_active_disputed", cell: (m) => m.itemsActiveDisputed },
  { header: "confirmation_requests", cell: (m) => m.confirmationRequests },
];

function rateCell(rate: number | null): string | null {
  return rate === null ? null : rate.toFixed(4);
}

/**
 * RFC 4180: quote fields containing a comma, quote, CR or LF; double embedded quotes. Text that
 * a spreadsheet would evaluate as a formula (leading = + - @ tab CR) is prefixed with `'`.
 */
function csvField(value: Cell): string {
  if (value === null) return "";
  let s = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * One row per engagement plus an org total row (`scope = org`), CRLF line endings. Rates are
 * decimals with 4 places; "n/a" (no denominator, no samples) is an empty cell.
 */
export function metricsToCsv(org: OrgMetrics, perEngagement: readonly EngagementMetrics[]): string {
  const header = ["scope", "engagement_id", "short_code", "engagement_name", "time_zone", ...CSV_COLUMNS.map((c) => c.header)];
  const row = (identity: Cell[], m: MetricsSummary) => [...identity, ...CSV_COLUMNS.map((c) => c.cell(m))];
  const rows: Cell[][] = [
    header,
    ...perEngagement.map((m) => row(["engagement", m.engagementId, m.shortCode, m.name, m.timeZone], m)),
    row(["org", null, null, null, null], org),
  ];
  return rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}
