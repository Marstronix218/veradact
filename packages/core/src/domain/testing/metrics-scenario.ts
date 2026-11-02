/**
 * A deterministic engagement for the pilot metrics (ARCHITECTURE §12) with known answers, shared by
 * the metrics unit tests, the seed script and the web/e2e metrics page tests. Test-only.
 *
 * Every timestamp is laid out in business days before `now` (Dn = `addBusinessDays(now, -n, tz)`)
 * with fixed hour offsets, so the expected numbers hold for any `now` and time zone. Two contacts
 * (`ops`, `cfo`), twelve items, six requests, fourteen sent item versions:
 *
 * | version  | sent | what happens                                      | counts as                   |
 * |----------|------|---------------------------------------------------|-----------------------------|
 * | R1 v1    | D10  | ops confirms +1h; R1 revised at D3                | matured, in window, churn   |
 * | R2 v1    | D10  | ops confirms +2h                                  | matured, in window          |
 * | R3 v1    | D10  | ops confirms +3h, cfo disputes +4h                | matured, in window, disputed|
 * | D1 v1    | D10  | cfo confirms +5h; D1 revised at D3 (not re-sent)  | matured, in window, churn   |
 * | C1 v1    | D10  | ops confirms +26h                                 | matured, in window          |
 * | R4 v1    | D10  | revised at D9 with no response                    | pulled                      |
 * | R4 v2    | D9   | ops confirms +8h                                  | matured, in window          |
 * | R5 v1    | D10  | ops confirms 6 business days later                | matured, late               |
 * | A1 v1    | D10  | cfo disputes +6h; A1 revised at D7                | matured, disputed           |
 * | A1 v2    | D7   | no response                                       | matured                     |
 * | P1 v1    | D10  | no response                                       | matured                     |
 * | R1 v2    | D3   | no response                                       | maturing                    |
 * | R6 v1    | D2   | ops confirms +4h                                  | maturing                    |
 * | R7 v1    | D1   | no response                                       | maturing                    |
 *
 * R8 is created and never sent. Expected: 6 of 10 matured confirmed in window (60%, on target),
 * 3 maturing, 1 pulled; median time to confirm 4.5 h over 8 samples (1, 2, 3, 4, 5, 8, 26 h and
 * the late one); 2 of 14 versions disputed; 8 links sent (one never sent), 4 interacted, 7 opened,
 * 11 raw opens; churn 2 (1 requirement); 3 spec exports, 2 record exports, 4 MCP fetches.
 */
import { addBusinessDays } from "../business-days";
import type { EngagementMetricsInput, LinkStat, MetricsSummary, UsageStat } from "../metrics";
import { LogBuilder } from "./log-builder";

export const METRICS_SCENARIO_NOW = new Date("2026-06-17T16:00:00.000Z");

export interface MetricsScenario {
  /** The builder that produced the log: use `builder.id("contact:ops")`, `builder.item("r1").id` etc. */
  builder: LogBuilder;
  input: EngagementMetricsInput;
  /** Every summary field except the raw duration samples (the late one depends on the calendar). */
  expected: Omit<MetricsSummary, "confirmDurationsMs">;
}

const HOUR = 3_600_000;

export function buildMetricsScenario(opts: { now?: Date; timeZone?: string } = {}): MetricsScenario {
  const now = opts.now ?? METRICS_SCENARIO_NOW;
  const timeZone = opts.timeZone ?? "America/New_York";
  const name = "Halvorsen dispatch pilot";
  const day = (n: number) => addBusinessDays(now, -n, timeZone);
  const plus = (t: Date, hours: number) => new Date(t.getTime() + hours * HOUR);
  const [d1, d2, d3, d7, d9, d10] = [day(1), day(2), day(3), day(7), day(9), day(10)];

  const b = new LogBuilder({ start: day(11), shortCode: "PILOT", engagement: "metrics-scenario" })
    .engagement({ name, clientName: "Halvorsen Freight", timeZone })
    .create("r1", "requirement", "Shipments are exported to the carrier SFTP every night.")
    .create("r2", "requirement", "Dispatchers can reassign a load from the board.")
    .create("r3", "requirement", "Proof-of-delivery photos are kept for 18 months.")
    .create("r4", "requirement", "Rate cards are imported from the shared spreadsheet.")
    .create("r5", "requirement", "Drivers see the next stop in the mobile app.")
    .create("r6", "requirement", "Late deliveries alert the account manager.")
    .create("r7", "requirement", "An invoice is generated when a load is delivered.")
    .create("r8", "requirement", "Customs documents can be attached to a load.")
    .create("d1", "decision", "Reporting runs on the existing Postgres cluster.")
    .create("c1", "constraint", "Customer data stays in the EU region.")
    .create("a1", "assumption", "The carrier API allows 10 requests per second.")
    .create("p1", "problem", "Dispatchers re-key every load into two systems.");

  // Steps run in time order (stable for equal times), whatever the calendar does to the offsets.
  const steps: { at: Date; run: () => void }[] = [];
  const step = (at: Date, run: () => void) => steps.push({ at, run });

  step(d10, () => b.request("q1", ["r1", "r2", "r3", "d1", "c1", "r4", "r5", "a1", "p1"], ["ops", "cfo"]));
  step(plus(d10, 0.5), () => b.authorize("ops", "q1").authorize("cfo", "q1"));
  step(plus(d10, 1), () => b.confirm("r1", "ops", "q1"));
  step(plus(d10, 2), () => b.confirm("r2", "ops", "q1"));
  step(plus(d10, 3), () => b.confirm("r3", "ops", "q1"));
  step(plus(d10, 4), () => b.dispute("r3", "cfo", "q1"));
  step(plus(d10, 5), () => b.confirm("d1", "cfo", "q1"));
  step(plus(d10, 6), () => b.dispute("a1", "cfo", "q1"));
  step(plus(d10, 26), () => b.confirm("c1", "ops", "q1"));
  step(d9, () => b.revise("r4", "Rate cards are imported nightly from the shared spreadsheet.").request("q2", ["r4"], ["ops"]));
  step(plus(d9, 8), () => b.confirm("r4", "ops", "q2"));
  step(d7, () =>
    b.revise("a1", "The carrier API allows 5 requests per second.", { reason: "client_dispute" }).request("q3", ["a1"], ["ops", "cfo"]),
  );
  step(addBusinessDays(d10, 6, timeZone), () => b.confirm("r5", "ops", "q1"));
  step(d3, () =>
    b
      .revise("r1", "Shipments are exported to the carrier SFTP every night by 02:00.")
      .revise("d1", "Reporting runs on a read replica of the Postgres cluster.")
      .request("q4", ["r1"], ["ops"]),
  );
  step(d2, () => b.request("q5", ["r6"], ["ops"]));
  step(plus(d2, 4), () => b.confirm("r6", "ops", "q5"));
  step(d1, () => b.request("q6", ["r7"], ["ops", "cfo"]));

  steps.sort((x, y) => x.at.getTime() - y.at.getTime());
  for (const s of steps) {
    b.at(s.at);
    s.run();
  }

  const link = (
    request: string,
    contact: string,
    sentAt: Date | null,
    opens: { first: Date; count: number } | null,
    interactedAt: Date | null,
  ): LinkStat => ({
    linkId: b.id(`link:${request}:${contact}`),
    requestId: b.id(`request:${request}`),
    contactId: b.id(`contact:${contact}`),
    emailSentAt: sentAt,
    firstOpenedAt: opens?.first ?? null,
    openCount: opens?.count ?? 0,
    firstInteractionAt: interactedAt,
    revokedAt: null,
  });
  const links: LinkStat[] = [
    link("q1", "ops", d10, { first: plus(d10, 0.25), count: 3 }, plus(d10, 0.5)),
    link("q1", "cfo", d10, { first: plus(d10, 0.25), count: 2 }, plus(d10, 0.5)),
    link("q2", "ops", d9, { first: plus(d9, 7), count: 1 }, plus(d9, 8)),
    link("q3", "ops", d7, { first: plus(d7, 0.01), count: 1 }, null), // mail-scanner prefetch
    link("q3", "cfo", d7, { first: plus(d7, 2), count: 2 }, null),
    link("q4", "ops", d3, null, null),
    link("q5", "ops", d2, { first: plus(d2, 3), count: 1 }, plus(d2, 4)),
    link("q6", "ops", d1, { first: plus(d1, 0.01), count: 1 }, null),
    link("q6", "cfo", null, null, null), // delivery failed: never sent
  ];

  const usage: UsageStat[] = [
    { kind: "spec_export", createdAt: plus(d2, 1) },
    { kind: "mcp_fetch", createdAt: plus(d2, 2) },
    { kind: "mcp_fetch", createdAt: plus(d2, 3) },
    { kind: "spec_export", createdAt: plus(d1, 1) },
    { kind: "spec_export", createdAt: plus(d1, 2) },
    { kind: "record_export_md", createdAt: plus(d1, 3) },
    { kind: "record_export_pdf", createdAt: plus(d1, 3) },
    { kind: "mcp_fetch", createdAt: plus(d1, 4) },
    { kind: "mcp_fetch", createdAt: plus(d1, 5) },
  ];

  return {
    builder: b,
    input: { engagementId: b.engagementId, shortCode: b.shortCode, name, timeZone, events: b.log, links, usage, now },
    expected: {
      versionsSent: 14,
      versionsMatured: 10,
      versionsMaturing: 3,
      versionsPulled: 1,
      versionsConfirmedInWindow: 6,
      confirmationRate: 0.6,
      rateBand: "on_target",
      medianHoursToConfirm: 4.5,
      timeToConfirmSamples: 8,
      versionsDisputed: 2,
      disputeRate: 2 / 14,
      linksSent: 8,
      linksInteracted: 4,
      linksOpened: 7,
      openCount: 11,
      linkEngagementRate: 0.5,
      linkOpenRate: 0.875,
      churnRevisions: 2,
      churnRequirementRevisions: 1,
      specExports: 3,
      recordExports: 2,
      mcpFetches: 4,
      itemsTotal: 12,
      itemsActivePending: 6,
      itemsActiveConfirmed: 5,
      itemsActiveDisputed: 1,
      confirmationRequests: 6,
    },
  };
}
