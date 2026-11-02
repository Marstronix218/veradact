import { describe, expect, it } from "vitest";
import { GENESIS_PREV_HASH } from "./chain";
import type { EventDraft, StoredEvent } from "./events";
import { fold, reduce } from "./reducer";
import { contactRevokedAt, currentVersionOf, emptyState, nextShortId, type EngagementState } from "./state";
import { LogBuilder } from "./testing/log-builder";

function toDraft(e: StoredEvent): EventDraft {
  return { type: e.type, payload: e.payload, actor: e.actor, occurredAt: e.occurredAt } as EventDraft;
}

function base() {
  return new LogBuilder()
    .engagement()
    .source("s1")
    .create("c1", "constraint", "Data stays in the EU", { spans: [{ source: "s1", start: 0, end: 20 }] })
    .create("a1", "assumption", "Carrier API is stable")
    .create("r1", "requirement", "Nightly export", { dependsOn: ["c1", "a1"] })
    .create("d1", "decision", "Use S3 in eu-west-1", { dependsOn: ["r1"] });
}

describe("emptyState", () => {
  it("starts with nothing and the genesis head", () => {
    const s = emptyState();
    expect(s.engagement).toBeNull();
    expect(s.headSeq).toBe(0);
    expect(s.headHash).toBe(GENESIS_PREV_HASH);
    expect(s.headRecordedAt).toBeNull();
    expect(s.items.size + s.sources.size + s.requests.size + s.authorizations.size).toBe(0);
    expect(s.kindCounters).toEqual({ problem: 0, constraint: 0, assumption: 0, decision: 0, requirement: 0 });
  });
});

describe("reduce", () => {
  it("tracks the engagement and head", () => {
    const b = new LogBuilder().engagement().tick().updateEngagement({ name: "Renamed", time_zone: "Europe/Berlin" });
    const s = fold(b.log);
    expect(s.engagement).toEqual({
      id: b.engagementId,
      orgId: b.orgId,
      shortCode: "HALV",
      name: "Renamed",
      clientName: "Halvorsen Freight",
      timeZone: "Europe/Berlin",
    });
    expect(s.headSeq).toBe(2);
    expect(s.headHash).toBe(b.last.hash);
    expect(s.headRecordedAt).toEqual(b.last.recordedAt);
    expect(nextShortId(s, "requirement")).toBe("HALV-R1");
    expect(() => nextShortId(emptyState(), "requirement")).toThrow();
  });

  it("projects sources and redactions", () => {
    const b = new LogBuilder().engagement().source("s1", { occurredAt: "2026-02-20T10:00:00.000Z" }).tick().redact("s1").tick().redact("s1");
    const s = fold(b.log);
    const src = s.sources.get(b.id("source:s1"))!;
    expect(src.occurredAt).toEqual(new Date("2026-02-20T10:00:00.000Z"));
    expect(src.ingestedBy).toBe(b.userId);
    expect(src.redacted).toEqual({ at: b.log[2]!.recordedAt, reasonCode: "user_request", seq: 3 });
  });

  it("creates items with short ids, kind counters and dependencies", () => {
    const b = base();
    const s = fold(b.log);
    const r1 = s.items.get(b.item("r1").id)!;
    expect(r1.shortId).toBe("HALV-R1");
    expect(r1.kind).toBe("requirement");
    expect(r1.currentVersion).toBe(1);
    expect(r1.status).toBe("pending");
    expect(r1.lifecycle).toBe("active");
    expect([...r1.dependsOn]).toEqual([
      [b.item("c1").id, 5],
      [b.item("a1").id, 5],
    ]);
    expect(r1.versions[0]!.manual).toEqual({ entered_by: b.userId });
    expect(r1.createdAt).toEqual(b.log[4]!.recordedAt);
    expect(r1.lastSeq).toBe(5);
    expect(s.kindCounters).toEqual({ problem: 0, constraint: 1, assumption: 1, decision: 1, requirement: 1 });
    expect(nextShortId(s, "decision")).toBe("HALV-D2");
  });

  describe("status (D-009)", () => {
    it("latest response per contact on the current version; disputed beats confirmed", () => {
      const b = base().request("q1", ["r1"], ["alice", "bob"]).authorize("alice", "q1").authorize("bob", "q1");
      const status = () => fold(b.log).items.get(b.item("r1").id)!.status;
      expect(status()).toBe("pending");
      b.confirm("r1", "alice", "q1");
      expect(status()).toBe("confirmed");
      b.dispute("r1", "bob", "q1");
      expect(status()).toBe("disputed");
      b.confirm("r1", "bob", "q1");
      expect(status()).toBe("confirmed");
      b.dispute("r1", "alice", "q1");
      expect(status()).toBe("disputed");
      b.confirm("r1", "alice", "q1");
      expect(status()).toBe("confirmed");
    });

    it("a revision returns to pending and old responses never carry over", () => {
      const b = base().request("q1", ["r1"], ["alice"]).authorize("alice", "q1").confirm("r1", "alice", "q1");
      const v1 = b.item("r1");
      b.revise("r1", "Nightly export at 02:00 UTC");
      let item = fold(b.log).items.get(v1.id)!;
      expect(item.status).toBe("pending");
      expect(item.currentVersion).toBe(2);
      expect(item.responses).toHaveLength(1);
      // A late response against v1 stays in history but does not affect v2's status.
      b.respond("confirmed", "r1", "alice", "q1", { version: 1, contentHash: v1.contentHash });
      item = fold(b.log).items.get(v1.id)!;
      expect(item.status).toBe("pending");
      expect(item.responses).toHaveLength(2);
      // A response naming v2 with v1's content hash does not count either.
      b.respond("confirmed", "r1", "alice", "q1", { version: 2, contentHash: v1.contentHash });
      expect(fold(b.log).items.get(v1.id)!.status).toBe("pending");
      b.confirm("r1", "alice", "q1");
      expect(fold(b.log).items.get(v1.id)!.status).toBe("confirmed");
    });
  });

  describe("needs review (D-011)", () => {
    it("revising an upstream item flags direct dependents only", () => {
      const b = base().tick().revise("c1", "Data stays in the EU and UK");
      const s = fold(b.log);
      const r1 = s.items.get(b.item("r1").id)!;
      const d1 = s.items.get(b.item("d1").id)!;
      expect(r1.needsReview).toBe(true);
      expect(r1.reviewReasons).toEqual([{ upstreamItemId: b.item("c1").id, cause: "revised", seq: b.last.seq }]);
      expect(r1.lastSeq).toBe(b.last.seq);
      expect(r1.updatedAt).toEqual(b.last.recordedAt);
      expect(d1.needsReview).toBe(false);
    });

    it("disputes on the current version flag dependents; confirmations and stale disputes do not", () => {
      const b = base().request("q1", ["c1", "a1"], ["alice"]).authorize("alice", "q1").confirm("c1", "alice", "q1");
      expect(fold(b.log).items.get(b.item("r1").id)!.needsReview).toBe(false);
      const a1v1 = b.item("a1");
      b.revise("a1", "Carrier API is stable until Q3").clearReview("r1");
      b.respond("disputed", "a1", "alice", "q1", { version: 1, contentHash: a1v1.contentHash });
      expect(fold(b.log).items.get(b.item("r1").id)!.needsReview).toBe(false);
      b.request("q2", ["a1"], ["alice"]).dispute("a1", "alice", "q2");
      const r1 = fold(b.log).items.get(b.item("r1").id)!;
      expect(r1.needsReview).toBe(true);
      expect(r1.reviewReasons.map((r) => r.cause)).toEqual(["disputed"]);
    });

    it("superseding or withdrawing flags dependents; reasons accumulate", () => {
      const b = base().create("c2", "constraint", "Data stays in the EEA").supersede("c1", "c2").withdraw("a1");
      const s = fold(b.log);
      const r1 = s.items.get(b.item("r1").id)!;
      expect(r1.reviewReasons.map((r) => [r.upstreamItemId, r.cause])).toEqual([
        [b.item("c1").id, "superseded"],
        [b.item("a1").id, "withdrawn"],
      ]);
      const c1 = s.items.get(b.item("c1").id)!;
      expect(c1.lifecycle).toBe("superseded");
      expect(c1.supersededBy).toBe(b.item("c2").id);
      expect(s.items.get(b.item("a1").id)!.lifecycle).toBe("withdrawn");
    });

    it("is cleared by the dependent's revision or review_cleared", () => {
      const b = base().revise("c1", "EU and UK");
      expect(fold(b.log).items.get(b.item("r1").id)!.needsReview).toBe(true);
      b.revise("r1", "Nightly export, EU and UK");
      let r1 = fold(b.log).items.get(b.item("r1").id)!;
      expect(r1.needsReview).toBe(false);
      expect(r1.reviewReasons).toEqual([]);
      // r1's revision flags its own dependent d1.
      expect(fold(b.log).items.get(b.item("d1").id)!.needsReview).toBe(true);
      b.revise("a1", "Carrier API v2 is stable");
      expect(fold(b.log).items.get(b.item("r1").id)!.needsReview).toBe(true);
      b.clearReview("r1");
      r1 = fold(b.log).items.get(b.item("r1").id)!;
      expect(r1.needsReview).toBe(false);
      expect(r1.reviewReasons).toEqual([]);
    });

    it("does not flag inactive dependents", () => {
      const b = base().withdraw("r1").revise("c1", "EU and UK");
      expect(fold(b.log).items.get(b.item("r1").id)!.needsReview).toBe(false);
    });
  });

  it("adds and removes dependencies", () => {
    const b = base().tick().addDep("d1", "c1").addDep("d1", "c1").removeDep("r1", "a1").removeDep("r1", "a1");
    const s = fold(b.log);
    expect([...s.items.get(b.item("d1").id)!.dependsOn]).toEqual([
      [b.item("r1").id, 6],
      [b.item("c1").id, 7],
    ]);
    expect([...s.items.get(b.item("r1").id)!.dependsOn.keys()]).toEqual([b.item("c1").id]);
  });

  it("tracks requests, revocations, authorizations, submissions and erasures", () => {
    const b = base().request("q1", ["c1", "r1"], ["alice", "bob"]);
    b.tick().revoke("q1", "bob").tick().revoke("q1", "carol").tick().authorize("alice", "q1", false).tick().authorize("alice", "q1");
    b.confirm("c1", "alice", "q1", { submission: "sub1" }).confirm("r1", "alice", "q1", { submission: "sub1" });
    b.tick().revoke("q1", null).tick().revoke("q1", null).eraseContact("bob").eraseContact("bob");
    const s = fold(b.log);
    const q1 = s.requests.get(b.id("request:q1"))!;
    expect(q1.items.map((i) => i.itemId)).toEqual([b.item("c1").id, b.item("r1").id]);
    expect(q1.contactIds).toEqual([b.id("contact:alice"), b.id("contact:bob")]);
    expect(q1.requestedBy).toBe(b.userId);
    const bobRevokedAt = b.log.find((e) => e.type === "confirmation_revoked")!.recordedAt;
    expect([...q1.revokedContacts]).toEqual([[b.id("contact:bob"), bobRevokedAt]]);
    const allRevokedAt = b.log.filter((e) => e.type === "confirmation_revoked")[2]!.recordedAt;
    expect(q1.revokedAllAt).toEqual(allRevokedAt);
    expect(contactRevokedAt(q1, b.id("contact:bob"))).toEqual(bobRevokedAt);
    expect(contactRevokedAt(q1, b.id("contact:alice"))).toEqual(allRevokedAt);
    const auth = s.authorizations.get(b.id("contact:alice"))!;
    expect(auth.decision).toBe("granted");
    expect(auth.textVersion).toBe("v1");
    expect([...s.submissions]).toEqual([b.id("submission:sub1")]);
    expect([...s.erasedContacts]).toEqual([b.id("contact:bob")]);
  });

  it("is total: unknown references and pre-genesis updates only advance the head", () => {
    const foreign = base().revise("c1", "x").clearReview("r1").request("q9", ["r1"], ["alice"]).confirm("r1", "alice", "q9");
    const b = new LogBuilder({ engagement: "e2" });
    b.updateEngagement({ name: "x" });
    for (const e of foreign.log.filter((x) => ["item_revised", "review_cleared", "item_confirmed"].includes(x.type))) b.push(toDraft(e));
    b.redact("missing").revoke("missing", null);
    const s = fold(b.log);
    expect(s.engagement).toBeNull();
    expect(s.items.size + s.sources.size + s.requests.size).toBe(0);
    expect(s.headSeq).toBe(b.log.length);
    expect(s.submissions.size).toBe(1);
  });

  it("ignores duplicate creations", () => {
    const b = base();
    b.push(toDraft(b.log[2]!));
    const s = fold(b.log);
    expect(s.kindCounters.constraint).toBe(1);
    expect(s.items.get(b.item("c1").id)!.lastSeq).toBe(3);
  });

  it("never mutates the input state", () => {
    const b = base()
      .request("q1", ["c1", "r1", "a1"], ["alice", "bob"])
      .authorize("alice", "q1")
      .confirm("c1", "alice", "q1")
      .dispute("a1", "alice", "q1")
      .revise("c1", "EU + UK")
      .addDep("d1", "c1")
      .removeDep("d1", "c1")
      .clearReview("r1")
      .revoke("q1", "bob")
      .revoke("q1", null)
      .create("c2", "constraint", "EEA")
      .supersede("c1", "c2")
      .withdraw("a1")
      .redact("s1")
      .eraseContact("bob")
      .authorize("alice", "q1", false)
      .updateEngagement({ client_name: "Halvorsen" });
    let state: EngagementState = emptyState();
    for (const event of b.log) {
      const snapshot = structuredClone(state);
      const next = reduce(state, event);
      expect(state).toEqual(snapshot);
      expect(next).not.toBe(state);
      state = next;
    }
    expect(currentVersionOf(state.items.get(b.item("c1").id)!).statement).toBe("EU + UK");
  });

  it("fold continues from an initial state", () => {
    const log = base().request("q1", ["r1"], ["alice"]).authorize("alice", "q1").confirm("r1", "alice", "q1").log;
    for (let k = 0; k <= log.length; k++) {
      expect(fold(log.slice(k), fold(log.slice(0, k)))).toEqual(fold(log));
    }
  });
});
