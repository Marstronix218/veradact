import { describe, expect, it } from "vitest";
import { PROJECTION_SORT_KEYS, PROJECTION_TABLES, projectRows, type ProjectionRows } from "./projection-rows";
import { fold } from "./reducer";
import { emptyState } from "./state";
import { LogBuilder } from "./testing/log-builder";

function scenario() {
  return new LogBuilder()
    .engagement()
    .source("s1")
    .source("s2")
    .create("c1", "constraint", "Data stays in the EU", { spans: [{ source: "s1", start: 0, end: 20 }] })
    .create("r1", "requirement", "Nightly export", { dependsOn: ["c1"], spans: [{ source: "s1", start: 30, end: 50 }] })
    .tick()
    .request("q1", ["c1", "r1"], ["alice", "bob"])
    .authorize("alice", "q1")
    .authorize("bob", "q1", false)
    .confirm("c1", "alice", "q1")
    .dispute("r1", "alice", "q1")
    .tick()
    .revise("r1", "Nightly export at 02:00 UTC", { spans: [{ source: "s2", start: 5, end: 9 }] })
    .revoke("q1", "bob")
    .redact("s2");
}

/** Column names from ARCHITECTURE §2.3 in camelCase. */
const COLUMNS: { [T in keyof ProjectionRows]: string[] } = {
  source: [
    "id",
    "orgId",
    "engagementId",
    "sourceType",
    "format",
    "occurredAt",
    "recordedAt",
    "contentSha256",
    "charLength",
    "participantCount",
    "attestation",
    "ingestedBy",
    "redactedAt",
    "redactionReason",
  ],
  item: [
    "id",
    "orgId",
    "engagementId",
    "shortId",
    "kind",
    "currentVersion",
    "status",
    "lifecycle",
    "supersededBy",
    "needsReview",
    "reviewReasons",
    "createdAt",
    "updatedAt",
    "lastSeq",
  ],
  item_version: [
    "itemId",
    "version",
    "orgId",
    "engagementId",
    "contentHash",
    "statement",
    "spans",
    "manual",
    "provenance",
    "reasonCode",
    "occurredAt",
    "recordedAt",
    "eventSeq",
  ],
  item_dependency: ["orgId", "engagementId", "itemId", "dependsOnItemId", "addedSeq"],
  item_response: [
    "orgId",
    "engagementId",
    "eventSeq",
    "itemId",
    "version",
    "contentHash",
    "contactId",
    "requestId",
    "submissionId",
    "response",
    "commentCommitment",
    "recordedAt",
  ],
  confirmation_request: ["id", "orgId", "engagementId", "requestedBy", "expiresAt", "recordedAt", "eventSeq"],
  confirmation_request_item: ["orgId", "engagementId", "requestId", "itemId", "version", "contentHash"],
  confirmation_request_contact: ["orgId", "engagementId", "requestId", "contactId", "revokedAt"],
  contact_authorization: [
    "orgId",
    "engagementId",
    "contactId",
    "requestId",
    "decision",
    "textVersion",
    "textSha256",
    "recordedAt",
    "eventSeq",
  ],
};

describe("projectRows", () => {
  it("is empty before genesis", () => {
    const rows = projectRows(emptyState());
    for (const t of PROJECTION_TABLES) expect(rows[t]).toEqual([]);
  });

  it("emits exactly the §2.3 columns for every table", () => {
    const rows = projectRows(fold(scenario().log));
    expect(Object.keys(rows).sort()).toEqual([...PROJECTION_TABLES].sort());
    for (const t of PROJECTION_TABLES) {
      expect(rows[t].length, t).toBeGreaterThan(0);
      for (const row of rows[t]) expect(Object.keys(row).sort(), t).toEqual([...COLUMNS[t]].sort());
    }
  });

  it("projects the scenario's values", () => {
    const b = scenario();
    const rows = projectRows(fold(b.log));
    const common = { orgId: b.orgId, engagementId: b.engagementId };
    const r1 = rows.item.find((i) => i.shortId === "HALV-R1")!;
    expect(r1).toMatchObject({ ...common, kind: "requirement", currentVersion: 2, status: "pending", lifecycle: "active", needsReview: false });
    const c1 = rows.item.find((i) => i.shortId === "HALV-C1")!;
    expect(c1.status).toBe("confirmed");
    expect(rows.item_response.map((r) => r.response)).toEqual(["confirmed", "disputed"]);
    expect(rows.item_response[1]!.commentCommitment).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.item_response[0]!.commentCommitment).toBeNull();
    expect(rows.item_dependency).toEqual([{ ...common, itemId: b.item("r1").id, dependsOnItemId: b.item("c1").id, addedSeq: 5 }]);
    expect(rows.confirmation_request).toEqual([
      { id: b.id("request:q1"), ...common, requestedBy: b.userId, expiresAt: expect.any(Date), recordedAt: b.log[5]!.recordedAt, eventSeq: 6 },
    ]);
    expect(rows.confirmation_request_item.map((r) => r.version)).toEqual([1, 1]);
    const revoked = rows.confirmation_request_contact.find((r) => r.contactId === b.id("contact:bob"))!;
    expect(revoked.revokedAt).toEqual(b.log.find((e) => e.type === "confirmation_revoked")!.recordedAt);
    expect(rows.confirmation_request_contact.find((r) => r.contactId === b.id("contact:alice"))!.revokedAt).toBeNull();
    expect(rows.contact_authorization.map((a) => a.decision).sort()).toEqual(["declined", "granted"]);
    const s2 = rows.source.find((s) => s.id === b.id("source:s2"))!;
    expect(s2.redactionReason).toBe("user_request");
    expect(s2.redactedAt).toEqual(b.last.recordedAt);
    expect(rows.source.find((s) => s.id === b.id("source:s1"))!.redactedAt).toBeNull();
  });

  it("marks spans carried over unchanged from the previous version", () => {
    const b = scenario();
    const rows = projectRows(fold(b.log));
    const versions = rows.item_version.filter((v) => v.itemId === b.item("r1").id);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0]!.spans.map((s) => s.carried)).toEqual([false]);
    expect(versions[1]!.spans.map((s) => [s.start, s.carried])).toEqual([
      [30, true],
      [5, false],
    ]);
    expect(versions[1]!.reasonCode).toBe("new_information");
    expect(versions[0]!.reasonCode).toBeNull();
    expect(Object.keys(versions[1]!.spans[0]!).sort()).toEqual(["carried", "end", "source_id", "source_sha256", "start"]);
  });

  it("uses snake_case jsonb for review reasons", () => {
    const b = scenario().revise("c1", "EU and UK");
    const r1 = projectRows(fold(b.log)).item.find((i) => i.id === b.item("r1").id)!;
    expect(r1.reviewReasons).toEqual([{ upstream_item_id: b.item("c1").id, cause: "revised", seq: b.last.seq }]);
  });

  it("is deterministic, sorted and shares nothing with state", () => {
    const state = fold(scenario().log);
    const a = projectRows(state);
    expect(projectRows(state)).toEqual(a);
    for (const t of PROJECTION_TABLES) {
      const keys = PROJECTION_SORT_KEYS[t] as readonly string[];
      const tuples = (a[t] as unknown as Record<string, string | number>[]).map((r) => keys.map((k) => r[k]));
      const sorted = [...tuples].sort((x, y) => {
        for (let i = 0; i < keys.length; i++) {
          if (x[i]! < y[i]!) return -1;
          if (x[i]! > y[i]!) return 1;
        }
        return 0;
      });
      expect(tuples, t).toEqual(sorted);
      expect(new Set(tuples.map((tp) => JSON.stringify(tp))).size, `${t} sort key is unique`).toBe(tuples.length);
    }
    a.item[0]!.createdAt.setTime(0);
    a.source[0]!.attestation.participant_jurisdictions.push("XX");
    a.item_version[0]!.spans.pop();
    expect(projectRows(state)).not.toEqual(a);
    expect(projectRows(state)).toEqual(projectRows(fold(scenario().log)));
  });
});
