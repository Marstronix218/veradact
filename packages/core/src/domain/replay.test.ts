import { describe, expect, it } from "vitest";
import { fold } from "./reducer";
import { asOf, decisionContext, diff } from "./replay";
import { LogBuilder } from "./testing/log-builder";

const T0 = "2026-03-02T15:00:00.000Z";
const T1 = "2026-03-03T15:00:00.000Z";
const T2 = "2026-03-04T15:00:00.000Z";
const T3 = "2026-03-05T15:00:00.000Z";
const T4 = "2026-03-06T15:00:00.000Z";
const at = (t: string, ms = 0) => new Date(new Date(t).getTime() + ms);

function history() {
  const b = new LogBuilder({ start: new Date(T0) })
    .engagement()
    .source("s1")
    .create("c1", "constraint", "Data stays in the EU", { spans: [{ source: "s1", start: 0, end: 20 }] })
    .create("r1", "requirement", "Nightly export", { dependsOn: ["c1"] })
    .create("d1", "decision", "Use S3", { dependsOn: ["r1"] });
  b.at(T1)
    .request("q1", ["c1", "r1", "d1"], ["alice", "bob"])
    .authorize("alice", "q1")
    .authorize("bob", "q1")
    .confirm("c1", "alice", "q1", { submission: "a" })
    .confirm("r1", "alice", "q1", { submission: "a" })
    .dispute("d1", "bob", "q1");
  b.at(T2).revise("r1", "Nightly export at 02:00 UTC");
  b.at(T3).request("q2", ["r1"], ["alice"]).confirm("r1", "alice", "q2").withdraw("d1").create("p1", "problem", "Manual invoicing is slow");
  b.at(T4).create("c2", "constraint", "Data stays in the EEA").supersede("c1", "c2").eraseContact("alice");
  return b;
}

describe("asOf known", () => {
  it("equals the fold of events recorded by T (inclusive)", () => {
    const b = history();
    const log = b.log;
    for (const t of [T0, T1, T2, T3, T4]) {
      const view = asOf(log, at(t), "known");
      expect(view.state).toEqual(fold(log.filter((e) => e.recordedAt.getTime() <= at(t).getTime())));
      expect(view.head.seq).toBe(view.state.headSeq);
    }
    expect(asOf(log, at(T0, -1), "known").items).toEqual([]);
    expect(asOf(log, at(T0, -1), "known").engagement).toBeNull();
  });

  it("shows items, versions and statuses as of T in display order", () => {
    const b = history();
    const atT1 = asOf(b.log, at(T1), "known");
    expect(atT1.items.map((i) => [i.shortId, i.status])).toEqual([
      ["HALV-C1", "confirmed"],
      ["HALV-D1", "disputed"],
      ["HALV-R1", "confirmed"],
    ]);
    const atT2 = asOf(b.log, at(T2), "known");
    const r1 = atT2.items.find((i) => i.shortId === "HALV-R1")!;
    expect(r1.versions.map((v) => [v.version, v.status])).toEqual([
      [1, "confirmed"],
      [2, "pending"],
    ]);
    expect(r1.current.version).toBe(2);
    expect(r1.versions[0]!.responses.map((r) => [r.response, r.contactErased])).toEqual([["confirmed", false]]);
    const d1 = atT2.items.find((i) => i.shortId === "HALV-D1")!;
    expect(d1.needsReview).toBe(true);
    expect(d1.reviewReasons).toEqual([{ upstreamItemId: b.item("r1").id, upstreamShortId: "HALV-R1", cause: "revised", seq: expect.any(Number) }]);
    expect(d1.dependsOn).toMatchObject([{ itemId: b.item("r1").id, shortId: "HALV-R1", status: "pending", currentVersion: 2 }]);
    const atT4 = asOf(b.log, at(T4), "known");
    const c1 = atT4.items.find((i) => i.shortId === "HALV-C1")!;
    expect(c1.lifecycle).toBe("superseded");
    expect(c1.supersededByShortId).toBe("HALV-C2");
    expect(atT4.items.map((i) => i.shortId)).toEqual(["HALV-P1", "HALV-C1", "HALV-C2", "HALV-D1", "HALV-R1"]);
  });
});

describe("asOf agreed (D-010)", () => {
  it("lists items whose current version is confirmed and active", () => {
    const b = history();
    const view = asOf(b.log, at(T1), "agreed");
    expect(view.items.map((i) => [i.shortId, i.version])).toEqual([
      ["HALV-C1", 1],
      ["HALV-R1", 1],
    ]);
    const c1 = view.items[0]!;
    expect(c1.contentHash).toBe(b.item("c1").contentHash);
    expect(c1.statement).toBe("Data stays in the EU");
    expect(c1.spans).toEqual([{ ...b.span({ source: "s1", start: 0, end: 20 }), carried: false }]);
    expect(c1.manual).toBeNull();
    expect(c1.confirmations).toEqual([
      {
        contactId: b.id("contact:alice"),
        contactErased: false,
        recordedAt: at(T1),
        requestId: b.id("request:q1"),
        submissionId: b.id("submission:a"),
        seq: expect.any(Number),
      },
    ]);
    expect(view.items[1]!.manual).toEqual({ entered_by: b.userId });
    expect(view.previouslyAgreed).toEqual([]);
    expect(view.notConfirmed.map((i) => [i.shortId, i.status, i.revisionPending])).toEqual([["HALV-D1", "disputed", false]]);
  });

  it("returns a revised item as previouslyAgreed, not agreed", () => {
    const b = history();
    const view = asOf(b.log, at(T2), "agreed");
    expect(view.items.map((i) => i.shortId)).toEqual(["HALV-C1"]);
    expect(view.previouslyAgreed).toEqual([
      {
        itemId: b.item("r1").id,
        shortId: "HALV-R1",
        kind: "requirement",
        currentVersion: 2,
        currentStatus: "pending",
        currentStatement: "Nightly export at 02:00 UTC",
        agreedVersion: 1,
        agreedContentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        agreedStatement: "Nightly export",
        confirmations: [expect.objectContaining({ contactId: b.id("contact:alice"), requestId: b.id("request:q1") })],
      },
    ]);
    expect(view.notConfirmed.map((i) => [i.shortId, i.revisionPending, i.needsReview])).toEqual([
      ["HALV-D1", false, true],
      ["HALV-R1", true, false],
    ]);
  });

  it("drops inactive items and marks erased confirmers", () => {
    const b = history();
    const atT3 = asOf(b.log, at(T3), "agreed");
    expect(atT3.items.map((i) => [i.shortId, i.version])).toEqual([
      ["HALV-C1", 1],
      ["HALV-R1", 2],
    ]);
    expect(atT3.notConfirmed.map((i) => i.shortId)).toEqual(["HALV-P1"]);
    const atT4 = asOf(b.log, at(T4), "agreed");
    expect(atT4.items.map((i) => i.shortId)).toEqual(["HALV-R1"]);
    expect(atT4.items[0]!.confirmations.map((c) => c.contactErased)).toEqual([true]);
    expect(atT4.items[0]!.needsReview).toBe(true);
    expect(atT4.items[0]!.reviewReasons.map((r) => [r.upstreamShortId, r.cause])).toEqual([["HALV-C1", "superseded"]]);
    expect(atT4.notConfirmed.map((i) => i.shortId)).toEqual(["HALV-P1", "HALV-C2"]);
  });
});

describe("diff", () => {
  it("reports added, revised, confirmed, disputed, superseded and withdrawn items", () => {
    const b = history();
    const d = diff(b.log, at(T1, 1), at(T4));
    expect(d.added.map((i) => i.shortId)).toEqual(["HALV-P1", "HALV-C2"]);
    expect(d.revised).toEqual([
      {
        itemId: b.item("r1").id,
        shortId: "HALV-R1",
        kind: "requirement",
        fromVersion: 1,
        toVersion: 2,
        fromContentHash: expect.any(String),
        toContentHash: b.item("r1").contentHash,
        fromStatement: "Nightly export",
        toStatement: "Nightly export at 02:00 UTC",
      },
    ]);
    expect(d.confirmed.map((c) => [c.shortId, c.version, c.contactErased])).toEqual([["HALV-R1", 2, true]]);
    expect(d.disputed).toEqual([]);
    expect(d.superseded.map((s) => [s.shortId, s.supersededByShortId, s.reasonCode])).toEqual([["HALV-C1", "HALV-C2", "scope_change"]]);
    expect(d.withdrawn.map((w) => [w.shortId, w.reasonCode])).toEqual([["HALV-D1", "out_of_scope"]]);
    const changes = Object.fromEntries(d.changes.map((c) => [c.shortId, [c.before?.status ?? null, c.after.status, c.after.lifecycle]]));
    expect(changes).toEqual({
      "HALV-P1": [null, "pending", "active"],
      "HALV-C1": ["confirmed", "confirmed", "superseded"],
      "HALV-C2": [null, "pending", "active"],
      "HALV-D1": ["disputed", "disputed", "withdrawn"],
      "HALV-R1": ["confirmed", "confirmed", "active"],
    });
    const r1 = d.changes.find((c) => c.shortId === "HALV-R1")!;
    expect([r1.before?.version, r1.after.version, r1.after.needsReview]).toEqual([1, 2, true]);
    expect(d.fromHead.seq).toBeLessThan(d.toHead.seq);
  });

  it("uses (T1, T2] and handles empty windows", () => {
    const b = history();
    const d = diff(b.log, at(T0), at(T1));
    expect(d.added).toEqual([]);
    expect(d.confirmed.map((c) => c.shortId)).toEqual(["HALV-C1", "HALV-R1"]);
    expect(d.disputed.map((c) => c.shortId)).toEqual(["HALV-D1"]);
    const empty = diff(b.log, at(T1), at(T1));
    expect([empty.added, empty.revised, empty.confirmed, empty.changes]).toEqual([[], [], [], []]);
    expect(() => diff(b.log, at(T2), at(T1))).toThrow(RangeError);
  });
});

describe("decisionContext", () => {
  it("is the known view through the version's event seq, with dependency status at that point", () => {
    const b = history();
    const ctx = decisionContext(b.log, b.item("d1").id)!;
    expect(ctx.shortId).toBe("HALV-D1");
    expect(ctx.version).toBe(1);
    expect(ctx.seq).toBe(5);
    expect(ctx.known.head.seq).toBe(5);
    expect(ctx.known.asOf).toEqual(ctx.recordedAt);
    expect(ctx.dependencies).toEqual([
      {
        itemId: b.item("r1").id,
        shortId: "HALV-R1",
        kind: "requirement",
        version: 1,
        contentHash: expect.any(String),
        statement: "Nightly export",
        status: "pending",
        lifecycle: "active",
        needsReview: false,
        addedSeq: 5,
      },
    ]);
  });

  it("selects a version and defaults to the latest", () => {
    const b = history();
    const latest = decisionContext(b.log, b.item("r1").id)!;
    expect(latest.version).toBe(2);
    expect(latest.dependencies.map((d) => [d.shortId, d.status])).toEqual([["HALV-C1", "confirmed"]]);
    const v1 = decisionContext(b.log, b.item("r1").id, 1)!;
    expect(v1.version).toBe(1);
    expect(v1.dependencies.map((d) => d.status)).toEqual(["pending"]);
    expect(decisionContext(b.log, b.item("r1").id, 3)).toBeNull();
    expect(decisionContext(b.log, b.id("item:nope"))).toBeNull();
  });

  it("cuts by seq, not time, so later events in the same millisecond are excluded", () => {
    const b = new LogBuilder()
      .engagement()
      .create("a1", "assumption", "A")
      .create("r1", "requirement", "R", { dependsOn: ["a1"] })
      .revise("a1", "A changed");
    const log = b.log;
    expect(new Set(log.map((e) => e.recordedAt.getTime())).size).toBe(1);
    const ctx = decisionContext(log, b.item("r1").id)!;
    expect(ctx.dependencies.map((d) => [d.version, d.statement])).toEqual([[1, "A"]]);
    expect(ctx.item.needsReview).toBe(false);
    expect(asOf(log, log[0]!.recordedAt, "known").items.find((i) => i.shortId === "HALV-R1")!.needsReview).toBe(true);
  });
});
