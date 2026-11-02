import { describe, expect, it } from "vitest";
import { sha256Hex } from "./hash";
import {
  contactRevokedAt,
  currentVersionOf,
  deriveStatus,
  latestResponsesByContact,
  spansWithCarried,
  versionStatus,
  type ItemResponse,
  type ItemVersion,
  type RequestState,
} from "./state";
import { testUuid } from "./testing/log-builder";

const h1 = sha256Hex("v1");
const h2 = sha256Hex("v2");
const span = (start: number, end: number) => ({ source_id: testUuid("s"), source_sha256: sha256Hex("t"), start, end });

function response(seq: number, contact: string, decision: "confirmed" | "disputed", version = 1, contentHash = h1): ItemResponse {
  return {
    seq,
    version,
    contentHash,
    contactId: testUuid(contact),
    requestId: testUuid("q"),
    submissionId: testUuid(`sub${seq}`),
    response: decision,
    channel: "email_link",
    evidenceCommitment: h1,
    commentCommitment: decision === "disputed" ? h2 : null,
    recordedAt: new Date(seq * 1000),
  };
}

function version(v: number, contentHash: string, spans = [span(0, 5)]): ItemVersion {
  return {
    version: v,
    contentHash,
    previousContentHash: null,
    statement: `v${v}`,
    spans,
    manual: null,
    provenance: { via: "manual" },
    reasonCode: null,
    occurredAt: new Date(0),
    recordedAt: new Date(0),
    seq: v,
  };
}

describe("status helpers", () => {
  it("keeps the latest response per contact for the exact version and hash", () => {
    const rs = [response(1, "a", "confirmed"), response(2, "b", "disputed"), response(3, "a", "disputed"), response(4, "b", "confirmed"), response(5, "a", "confirmed", 2, h2)];
    expect(latestResponsesByContact(rs, 1, h1).map((r) => r.seq)).toEqual([3, 4]);
    expect(latestResponsesByContact(rs, 2, h2).map((r) => r.seq)).toEqual([5]);
    expect(latestResponsesByContact(rs, 2, h1)).toEqual([]);
  });

  it("derives pending / confirmed / disputed (D-009)", () => {
    expect(versionStatus([], 1, h1)).toBe("pending");
    expect(versionStatus([response(1, "a", "confirmed")], 1, h1)).toBe("confirmed");
    expect(versionStatus([response(1, "a", "confirmed"), response(2, "b", "disputed")], 1, h1)).toBe("disputed");
    expect(versionStatus([response(1, "a", "disputed"), response(2, "a", "confirmed")], 1, h1)).toBe("confirmed");
    const item = { versions: [version(1, h1), version(2, h2)], currentVersion: 2, responses: [response(1, "a", "confirmed")] };
    expect(deriveStatus(item)).toBe("pending");
    expect(deriveStatus({ ...item, currentVersion: 1 })).toBe("confirmed");
    expect(deriveStatus({ ...item, currentVersion: 3 })).toBe("pending");
  });

  it("finds the current version", () => {
    const versions = [version(1, h1), version(2, h2)];
    expect(currentVersionOf({ versions, currentVersion: 1 }).contentHash).toBe(h1);
    expect(currentVersionOf({ versions, currentVersion: 9 }).contentHash).toBe(h2);
    expect(() => currentVersionOf({ versions: [], currentVersion: 1 })).toThrow();
  });
});

describe("spansWithCarried", () => {
  it("flags spans identical to one on the previous version", () => {
    const versions = [version(1, h1, [span(0, 5), span(10, 20)]), version(2, h2, [span(10, 20), span(0, 6)])];
    expect(spansWithCarried({ versions }, 1).map((s) => s.carried)).toEqual([false, false]);
    expect(spansWithCarried({ versions }, 2).map((s) => [s.start, s.carried])).toEqual([
      [10, true],
      [0, false],
    ]);
    expect(spansWithCarried({ versions }, 3)).toEqual([]);
  });
});

describe("contactRevokedAt", () => {
  const base: RequestState = {
    id: testUuid("q"),
    items: [],
    contactIds: [testUuid("a"), testUuid("b")],
    revokedContacts: new Map(),
    revokedAllAt: null,
    expiresAt: new Date(10_000),
    channel: "email_link",
    requestedBy: testUuid("u"),
    recordedAt: new Date(0),
    seq: 1,
  };

  it("is the earlier of the contact's own and the all-contacts revocation", () => {
    expect(contactRevokedAt(base, testUuid("a"))).toBeNull();
    const own = { ...base, revokedContacts: new Map([[testUuid("a"), new Date(5)]]) };
    expect(contactRevokedAt(own, testUuid("a"))).toEqual(new Date(5));
    expect(contactRevokedAt({ ...own, revokedAllAt: new Date(3) }, testUuid("a"))).toEqual(new Date(3));
    expect(contactRevokedAt({ ...own, revokedAllAt: new Date(7) }, testUuid("a"))).toEqual(new Date(5));
    expect(contactRevokedAt({ ...own, revokedAllAt: new Date(7) }, testUuid("b"))).toEqual(new Date(7));
  });
});
