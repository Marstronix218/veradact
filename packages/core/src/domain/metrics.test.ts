import { describe, expect, it } from "vitest";
import { addBusinessDays } from "./business-days";
import { verifyChain } from "./chain";
import {
  aggregateOrgMetrics,
  computeEngagementMetrics,
  metricsToCsv,
  rateBand,
  type EngagementMetricsInput,
  type LinkStat,
} from "./metrics";
import { LogBuilder } from "./testing/log-builder";
import { buildMetricsScenario, METRICS_SCENARIO_NOW } from "./testing/metrics-scenario";

const NY = "America/New_York";
const HOUR = 3_600_000;
/** Monday 2026-04-13 10:00 EDT; + 5 business days = Monday 2026-04-20 10:00 EDT (168 h later). */
const MON = new Date("2026-04-13T14:00:00.000Z");
const d = (iso: string) => new Date(iso);

function metrics(b: LogBuilder, now: Date | string, extra: Partial<EngagementMetricsInput> = {}) {
  return computeEngagementMetrics({
    engagementId: b.engagementId,
    shortCode: b.shortCode,
    name: "Halvorsen rollout",
    timeZone: NY,
    events: b.log,
    links: [],
    usage: [],
    now: new Date(now),
    ...extra,
  });
}

/** Engagement with requirements r1..rn created at `start`. */
function withItems(n: number, start = MON, engagement = "e1"): LogBuilder {
  const b = new LogBuilder({ start, engagement }).engagement();
  for (let i = 1; i <= n; i++) b.create(`r${i}`, "requirement", `Requirement number ${i}`);
  return b;
}

const names = (n: number) => Array.from({ length: n }, (_, i) => `r${i + 1}`);

/** One request at MON for one requirement per entry; entry = hours until contact `a` confirms (null = never). */
function oneRequest(confirmHours: readonly (number | null)[], engagement = "e1"): LogBuilder {
  const b = withItems(confirmHours.length, MON, engagement);
  b.request("q1", names(confirmHours.length), ["a"]).tick(1000).authorize("a", "q1");
  confirmHours
    .map((h, i) => ({ h, name: `r${i + 1}` }))
    .filter((x): x is { h: number; name: string } => x.h !== null)
    .sort((x, y) => x.h - y.h)
    .forEach(({ h, name }) => b.at(new Date(MON.getTime() + h * HOUR)).confirm(name, "a", "q1"));
  return b;
}

describe("5-business-day confirmation rate", () => {
  it("counts a confirmation up to window_end and not one business day after it", () => {
    const b = withItems(3).request("q1", ["r1", "r2", "r3"], ["a"]).tick(1000).authorize("a", "q1");
    b.at("2026-04-20T13:00:00.000Z").confirm("r1", "a", "q1"); // an hour before window_end
    b.at("2026-04-20T14:00:00.000Z").confirm("r2", "a", "q1"); // exactly at window_end
    b.at("2026-04-21T14:00:00.000Z").confirm("r3", "a", "q1"); // one business day after
    const m = metrics(b, "2026-04-22T00:00:00.000Z");
    expect(m).toMatchObject({ versionsSent: 3, versionsMatured: 3, versionsConfirmedInWindow: 2, versionsMaturing: 0 });
    expect(m.confirmationRate).toBeCloseTo(2 / 3, 10);
    expect(m.rateBand).toBe("on_target");
    // Time to confirm counts every confirmation, inside the window or not.
    expect(m.timeToConfirmSamples).toBe(3);
    expect(m.medianHoursToConfirm).toBe(168);
  });

  it("skips the weekend: sent Friday afternoon, the window ends next Friday at the same local time", () => {
    // Friday 2026-04-17 15:30 EDT → Friday 2026-04-24 15:30 EDT.
    const b = withItems(1, d("2026-04-17T19:30:00.000Z")).request("q1", ["r1"], ["a"]).tick(1000).authorize("a", "q1");
    b.at("2026-04-24T19:30:00.000Z").confirm("r1", "a", "q1");
    // Five calendar days later (Wednesday) it is still maturing.
    expect(metrics(b, "2026-04-22T19:30:00.000Z")).toMatchObject({ versionsMaturing: 1, versionsMatured: 0, confirmationRate: null });
    const before = metrics(b, "2026-04-24T19:29:59.999Z");
    expect(before).toMatchObject({ versionsMaturing: 1, versionsMatured: 0, confirmationRate: null, rateBand: "insufficient_data" });
    const at = metrics(b, "2026-04-24T19:30:00.000Z");
    expect(at).toMatchObject({ versionsMaturing: 0, versionsMatured: 1, versionsConfirmedInWindow: 1, confirmationRate: 1 });
    expect(addBusinessDays(d("2026-04-17T19:30:00.000Z"), 5, NY)).toEqual(d("2026-04-24T19:30:00.000Z"));
  });

  it("keeps local wall time across the America/New_York spring-forward (2026-03-08)", () => {
    // Friday 2026-03-06 15:00 EST (20:00Z) → Friday 2026-03-13 15:00 EDT (19:00Z), 167 h later.
    const b = withItems(2, d("2026-03-06T20:00:00.000Z")).request("q1", ["r1", "r2"], ["a"]).tick(1000).authorize("a", "q1");
    b.at("2026-03-13T19:00:00.000Z").confirm("r1", "a", "q1");
    b.at("2026-03-13T19:30:00.000Z").confirm("r2", "a", "q1"); // inside a naive 7 × 24 h window, outside the real one
    expect(metrics(b, "2026-03-13T18:59:59.999Z")).toMatchObject({ versionsMaturing: 2, versionsMatured: 0 });
    expect(metrics(b, "2026-03-13T19:00:00.000Z")).toMatchObject({ versionsMaturing: 0, versionsMatured: 2 });
    expect(metrics(b, "2026-03-16T12:00:00.000Z")).toMatchObject({ versionsMatured: 2, versionsConfirmedInWindow: 1, confirmationRate: 0.5 });
  });

  it("keeps local wall time across the America/New_York fall-back (2026-11-01)", () => {
    // Friday 2026-10-30 15:00 EDT (19:00Z) → Friday 2026-11-06 15:00 EST (20:00Z), 169 h later.
    const b = withItems(1, d("2026-10-30T19:00:00.000Z")).request("q1", ["r1"], ["a"]).tick(1000).authorize("a", "q1");
    b.at("2026-11-06T19:30:00.000Z").confirm("r1", "a", "q1"); // outside a naive 7 × 24 h window, inside the real one
    expect(metrics(b, "2026-11-06T19:59:59.999Z")).toMatchObject({ versionsMaturing: 1, versionsMatured: 0 });
    expect(metrics(b, "2026-11-09T12:00:00.000Z")).toMatchObject({ versionsMatured: 1, versionsConfirmedInWindow: 1, confirmationRate: 1 });
  });

  it("excludes a version still maturing from numerator and denominator", () => {
    const b = withItems(2).request("q1", ["r1"], ["a"]).tick(1000).authorize("a", "q1");
    b.at("2026-04-16T14:00:00.000Z").request("q2", ["r2"], ["a"]).tick(HOUR).confirm("r2", "a", "q2");
    // r1 matured on 04-20 unconfirmed; r2 (sent Thursday) matures 04-23 and is confirmed.
    const m = metrics(b, "2026-04-21T14:00:00.000Z");
    expect(m).toMatchObject({ versionsSent: 2, versionsMatured: 1, versionsMaturing: 1, versionsConfirmedInWindow: 0 });
    expect(m.confirmationRate).toBe(0);
    expect(m.rateBand).toBe("kill_signal");
    expect(m.timeToConfirmSamples).toBe(1);
  });

  it("excludes versions pulled before window_end without a response, but not after a response or after the window", () => {
    const b = withItems(6).request("q1", ["r1", "r2", "r3", "r5", "r6"], ["a"]).tick(1000).authorize("a", "q1");
    b.at("2026-04-14T14:00:00.000Z").revise("r1", "Requirement number 1, clarified").request("q2", ["r1"], ["a"]); // r1 v1 pulled
    b.tick(HOUR).confirm("r1", "a", "q2"); // r1 v2: a new unit, confirmed in its window
    b.tick(HOUR).withdraw("r2"); // pulled
    b.tick(HOUR).supersede("r3", "r4"); // pulled
    b.tick(HOUR).dispute("r5", "a", "q1").tick(HOUR).revise("r5", "Requirement number 5, after the dispute"); // not pulled: responded
    b.at("2026-04-21T15:00:00.000Z").withdraw("r6"); // after window_end (04-20 14:00Z): not pulled
    const m = metrics(b, "2026-04-22T14:00:00.000Z");
    expect(m).toMatchObject({
      versionsSent: 6,
      versionsPulled: 3,
      versionsMatured: 3,
      versionsMaturing: 0,
      versionsConfirmedInWindow: 1,
      versionsDisputed: 1,
    });
    expect(m.confirmationRate).toBeCloseTo(1 / 3, 10);
    expect(m.disputeRate).toBeCloseTo(1 / 6, 10);
  });

  it("counts a revised version re-sent as a new unit, and a re-requested version once from its first request", () => {
    const b = withItems(1).request("q1", ["r1"], ["a"]).tick(1000).authorize("a", "q1");
    b.at("2026-04-15T14:00:00.000Z").request("q2", ["r1"], ["a"]); // same version again
    // Inside q2's window but after the window of the first request (04-20 14:00Z).
    b.at("2026-04-20T15:00:00.000Z").confirm("r1", "a", "q2");
    expect(metrics(b, "2026-04-21T00:00:00.000Z")).toMatchObject({ versionsSent: 1, versionsMatured: 1, versionsConfirmedInWindow: 0 });
    b.at("2026-04-21T14:00:00.000Z").revise("r1", "Requirement number 1, revised").request("q3", ["r1"], ["a"]);
    b.tick(HOUR).confirm("r1", "a", "q3");
    const m = metrics(b, "2026-04-29T00:00:00.000Z");
    expect(m).toMatchObject({ versionsSent: 2, versionsMatured: 2, versionsConfirmedInWindow: 1, confirmationRate: 0.5 });
    expect(m.confirmDurationsMs).toEqual([HOUR, 169 * HOUR]);
    expect(m.medianHoursToConfirm).toBe(85);
  });

  it("counts a version one contact confirms and another disputes as confirmed in window and disputed", () => {
    const b = withItems(1).request("q1", ["r1"], ["a", "b"]).tick(1000).authorize("a", "q1").authorize("b", "q1");
    b.tick(HOUR).confirm("r1", "a", "q1").tick(HOUR).dispute("r1", "b", "q1");
    const m = metrics(b, "2026-04-22T00:00:00.000Z");
    expect(m).toMatchObject({ versionsMatured: 1, versionsConfirmedInWindow: 1, confirmationRate: 1, versionsDisputed: 1, disputeRate: 1 });
    expect(m.itemsActiveDisputed).toBe(1); // D-009: any dispute blocks the item status
  });

  it("ignores events, links and usage recorded after now", () => {
    const b = oneRequest([1, 2]);
    const m = metrics(b, new Date(MON.getTime() + 1.5 * HOUR), {
      usage: [
        { kind: "spec_export", createdAt: MON },
        { kind: "spec_export", createdAt: d("2026-05-01T00:00:00.000Z") },
      ],
    });
    expect(m).toMatchObject({ versionsMaturing: 2, timeToConfirmSamples: 1, itemsActiveConfirmed: 1, itemsActivePending: 1, specExports: 1 });
  });
});

describe("median time to confirm", () => {
  it("takes the middle sample for odd counts and the mean of the middle two for even counts", () => {
    expect(metrics(oneRequest([10, 1, 2]), "2026-05-04T00:00:00.000Z").medianHoursToConfirm).toBe(2);
    expect(metrics(oneRequest([10, 1, 3, 2, null]), "2026-05-04T00:00:00.000Z")).toMatchObject({
      medianHoursToConfirm: 2.5,
      timeToConfirmSamples: 4,
    });
  });

  it("rounds to one decimal and is null without samples", () => {
    expect(metrics(oneRequest([4 / 3]), "2026-05-04T00:00:00.000Z").medianHoursToConfirm).toBe(1.3);
    expect(metrics(oneRequest([null]), "2026-05-04T00:00:00.000Z")).toMatchObject({ medianHoursToConfirm: null, timeToConfirmSamples: 0 });
  });
});

describe("link engagement", () => {
  const link = (id: string, overrides: Partial<LinkStat>): LinkStat => ({
    linkId: id,
    requestId: "q1",
    contactId: id,
    emailSentAt: MON,
    firstOpenedAt: null,
    openCount: 0,
    firstInteractionAt: null,
    revokedAt: null,
    ...overrides,
  });

  it("uses first interaction as the headline and reports raw opens separately", () => {
    const opened = new Date(MON.getTime() + HOUR);
    const links = [
      link("l1", { firstOpenedAt: opened, openCount: 3, firstInteractionAt: new Date(MON.getTime() + 2 * HOUR) }),
      link("l2", { firstOpenedAt: opened, openCount: 1 }), // mail-scanner prefetch only
      link("l3", {}), // never opened
      link("l4", { emailSentAt: null }), // never sent
      link("l5", { emailSentAt: d("2026-05-01T00:00:00.000Z") }), // sent after now
    ];
    const m = metrics(withItems(0), "2026-04-20T00:00:00.000Z", { links });
    expect(m).toMatchObject({ linksSent: 3, linksInteracted: 1, linksOpened: 2, openCount: 4 });
    expect(m.linkEngagementRate).toBeCloseTo(1 / 3, 10);
    expect(m.linkOpenRate).toBeCloseTo(2 / 3, 10);
  });
});

describe("requirement churn", () => {
  it("counts only revisions of items that had a confirmation before the revision", () => {
    const b = new LogBuilder({ start: MON }).engagement();
    b.create("r1", "requirement", "Nightly export").create("r2", "requirement", "Daily digest").create("d1", "decision", "Use S3");
    b.revise("r1", "Nightly export at 02:00"); // before any confirmation: not churn
    b.tick().request("q1", ["r1", "r2", "d1"], ["a"]).tick().authorize("a", "q1");
    b.tick().confirm("r1", "a", "q1").confirm("d1", "a", "q1").dispute("r2", "a", "q1");
    b.tick().revise("r1", "Nightly export at 03:00"); // churn
    b.tick().revise("r1", "Nightly export at 04:00"); // churn: the item had a confirmed version before
    b.tick().revise("d1", "Use S3 in eu-west-1"); // churn, not a requirement
    b.tick().revise("r2", "Weekly digest"); // only disputed before: not churn
    const m = metrics(b, "2026-04-14T00:00:00.000Z");
    expect(m).toMatchObject({ churnRevisions: 3, churnRequirementRevisions: 2 });
  });
});

describe("usage and context counts", () => {
  it("counts exports, MCP fetches, items and requests", () => {
    const b = oneRequest([1, null]).tick().create("c1", "constraint", "EU only").tick().withdraw("c1");
    const usage = (["spec_export", "record_export_md", "record_export_pdf", "mcp_fetch", "mcp_fetch"] as const).map((kind) => ({
      kind,
      createdAt: MON,
    }));
    const m = metrics(b, "2026-05-04T00:00:00.000Z", { usage });
    expect(m).toMatchObject({
      specExports: 1,
      recordExports: 2,
      mcpFetches: 2,
      itemsTotal: 3,
      itemsActivePending: 1,
      itemsActiveConfirmed: 1,
      itemsActiveDisputed: 0,
      confirmationRequests: 1,
    });
  });
});

describe("aggregateOrgMetrics", () => {
  it("recomputes rates from summed counts and the median from pooled samples", () => {
    const a = metrics(oneRequest([1], "a"), "2026-05-04T00:00:00.000Z"); // 1 of 1, samples [1 h]
    const b = metrics(oneRequest([2, 200, null], "b"), "2026-05-04T00:00:00.000Z"); // 1 of 3, samples [2 h, 200 h]
    expect(a.confirmationRate).toBe(1);
    expect(b.confirmationRate).toBeCloseTo(1 / 3, 10);
    expect(b.medianHoursToConfirm).toBe(101);
    const org = aggregateOrgMetrics([a, b]);
    expect(org).toMatchObject({
      engagementCount: 2,
      versionsSent: 4,
      versionsMatured: 4,
      versionsConfirmedInWindow: 2,
      confirmationRate: 0.5, // not the mean of the rates (0.667)
      rateBand: "on_target",
      timeToConfirmSamples: 3,
      medianHoursToConfirm: 2, // not the mean of the medians (51)
      disputeRate: 0,
      itemsTotal: 4,
      confirmationRequests: 2,
    });
    expect(org.confirmDurationsMs).toEqual([HOUR, 2 * HOUR, 200 * HOUR]);
  });

  it("has n/a rates for an empty org", () => {
    expect(aggregateOrgMetrics([])).toMatchObject({
      engagementCount: 0,
      versionsSent: 0,
      confirmationRate: null,
      rateBand: "insufficient_data",
      medianHoursToConfirm: null,
      disputeRate: null,
      linkEngagementRate: null,
      linkOpenRate: null,
    });
  });
});

describe("metricsToCsv", () => {
  it("writes RFC 4180 rows per engagement plus an org total, with empty cells for n/a", () => {
    const quoted = { ...metrics(oneRequest([1], "a"), "2026-05-04T00:00:00.000Z"), name: 'Acme, "North" rollout' };
    const empty = new LogBuilder({ start: MON, engagement: "empty", shortCode: "EMPT" }).engagement({ timeZone: "Europe/Berlin" });
    const none = computeEngagementMetrics({
      engagementId: empty.engagementId,
      shortCode: "EMPT",
      name: "Empty",
      timeZone: "Europe/Berlin",
      events: empty.log,
      links: [],
      usage: [],
      now: d("2026-05-04T00:00:00.000Z"),
    });
    const csv = metricsToCsv(aggregateOrgMetrics([quoted, none]), [quoted, none]);
    expect(csv.endsWith("\r\n")).toBe(true);
    const lines = csv.slice(0, -2).split("\r\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(
      [
        "scope,engagement_id,short_code,engagement_name,time_zone",
        "versions_sent,versions_matured,versions_maturing,versions_pulled,versions_confirmed_within_5_business_days",
        "confirmation_rate_5_business_days,confirmation_rate_band,median_hours_to_confirm,time_to_confirm_samples",
        "versions_disputed,dispute_rate,links_sent,links_interacted,link_engagement_rate,links_opened_raw,link_open_rate_raw,open_count_raw",
        "churn_revisions_all_kinds,churn_revisions_requirements,spec_exports,record_exports,mcp_fetches",
        "items_total,items_active_pending,items_active_confirmed,items_active_disputed,confirmation_requests",
      ].join(","),
    );
    expect(lines[1]).toBe(
      `engagement,${quoted.engagementId},HALV,"Acme, ""North"" rollout",America/New_York,1,1,0,0,1,1.0000,on_target,1,1,0,0.0000,0,0,,0,,0,0,0,0,0,0,1,0,1,0,1`,
    );
    expect(lines[2]).toBe(`engagement,${none.engagementId},EMPT,Empty,Europe/Berlin,0,0,0,0,0,,insufficient_data,,0,0,,0,0,,0,,0,0,0,0,0,0,0,0,0,0,0`);
    expect(lines[3]).toBe("org,,,,,1,1,0,0,1,1.0000,on_target,1,1,0,0.0000,0,0,,0,,0,0,0,0,0,0,1,0,1,0,1");
  });

  it("neutralizes text a spreadsheet would evaluate as a formula", () => {
    const base = metrics(oneRequest([1], "a"), "2026-05-04T00:00:00.000Z");
    for (const name of ["=HYPERLINK(\"x\")", "+1", "-2", "@SUM(A1)"]) {
      const row = metricsToCsv(aggregateOrgMetrics([{ ...base, name }]), [{ ...base, name }]).split("\r\n")[1]!;
      expect(row.split(",")[3]?.replace(/^"/, "").startsWith("'")).toBe(true);
    }
  });

  it("formats rates with four decimals and medians unformatted", () => {
    const s = computeEngagementMetrics(buildMetricsScenario().input);
    const row = metricsToCsv(aggregateOrgMetrics([s]), [s]).split("\r\n")[1]!;
    expect(row).toContain(",14,10,3,1,6,0.6000,on_target,4.5,8,2,0.1429,8,4,0.5000,7,0.8750,11,2,1,3,2,4,12,6,5,1,6");
  });
});

describe("rateBand", () => {
  it("bands at exactly 0.25 and 0.50", () => {
    expect(rateBand(null)).toBe("insufficient_data");
    expect(rateBand(0)).toBe("kill_signal");
    expect(rateBand(0.2499)).toBe("kill_signal");
    expect(rateBand(0.25)).toBe("watch");
    expect(rateBand(0.4999)).toBe("watch");
    expect(rateBand(0.5)).toBe("on_target");
    expect(rateBand(1)).toBe("on_target");
  });
});

describe("buildMetricsScenario", () => {
  it("produces a valid log with the documented numbers", () => {
    const s = buildMetricsScenario();
    expect(s.input.now).toEqual(METRICS_SCENARIO_NOW);
    expect(verifyChain(s.input.events).ok).toBe(true);
    const m = computeEngagementMetrics(s.input);
    expect(m).toMatchObject(s.expected);
    expect(m.versionsMatured + m.versionsMaturing + m.versionsPulled).toBe(m.versionsSent);
    expect(m.confirmDurationsMs.slice(0, 7)).toEqual([1, 2, 3, 4, 5, 8, 26].map((h) => h * HOUR));
  });

  it.each([
    ["a Saturday", "2026-06-20T15:00:00.000Z", NY],
    ["a Monday morning", "2026-06-15T12:30:00.000Z", NY],
    ["the week after the US spring-forward", "2026-03-10T13:00:00.000Z", NY],
    ["the week after the US fall-back", "2026-11-03T21:00:00.000Z", NY],
    ["a late evening in Berlin", "2026-10-28T21:45:00.000Z", "Europe/Berlin"],
    ["Tokyo", "2026-01-05T01:00:00.000Z", "Asia/Tokyo"],
  ])("keeps the same numbers for now = %s", (_label, now, timeZone) => {
    const s = buildMetricsScenario({ now: d(now), timeZone });
    const last = s.input.events[s.input.events.length - 1]!;
    expect(last.recordedAt.getTime()).toBeLessThanOrEqual(s.input.now.getTime());
    expect(computeEngagementMetrics(s.input)).toMatchObject(s.expected);
  });
});
