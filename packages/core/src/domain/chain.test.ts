import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical";
import {
  computeEventHash,
  GENESIS_PREV_HASH,
  nextRecordedAt,
  resolveOccurredAt,
  sealEvent,
  verifyChain,
  type ChainRow,
} from "./chain";
import type { EventDraft, StoredEvent } from "./events";
import { sha256Hex } from "./hash";
import { chainDrafts } from "./testing/arbitraries";
import { LogBuilder, testUuid } from "./testing/log-builder";

function sampleLog(): StoredEvent[] {
  return new LogBuilder()
    .engagement()
    .source("s1")
    .tick()
    .create("c1", "constraint", "EU only", { spans: [{ source: "s1", start: 0, end: 5 }] })
    .create("r1", "requirement", "Nightly export", { dependsOn: ["c1"] })
    .tick()
    .request("q1", ["c1", "r1"], ["alice"])
    .authorize("alice", "q1")
    .confirm("c1", "alice", "q1")
    .revoke("q1", null)
    .redact("s1").log;
}

/** Plain JSON copy of a row with Dates preserved (what a driver would return). */
function cloneRows(rows: readonly StoredEvent[]): ChainRow[] {
  return rows.map((r) => structuredClone(r));
}

type Mutation = { name: string; apply: (row: ChainRow) => void };

/** Changes the first leaf found in a JSON value (string, number, boolean or null). */
function mutateFirstLeaf(value: unknown): boolean {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const v: unknown = value[i];
      if (v === null || typeof v !== "object") {
        value[i] = mutateLeaf(v);
        return true;
      }
      if (mutateFirstLeaf(v)) return true;
    }
    return false;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const k of Object.keys(record).sort()) {
      const v = record[k];
      if (v === null || typeof v !== "object") {
        record[k] = mutateLeaf(v);
        return true;
      }
      if (mutateFirstLeaf(v)) return true;
    }
  }
  return false;
}

function mutateLeaf(v: unknown): unknown {
  if (typeof v === "string") return `${v}x`;
  if (typeof v === "number") return v + 1;
  if (typeof v === "boolean") return !v;
  return "was-null";
}

const mutations: Mutation[] = [
  { name: "payload value", apply: (r) => void mutateFirstLeaf(r.payload) },
  { name: "type", apply: (r) => void (r.type = r.type === "contact_erased" ? "review_cleared" : "contact_erased") },
  { name: "actor type", apply: (r) => void (r.actor = { ...r.actor, type: r.actor.type === "user" ? "contact" : "user" }) },
  { name: "actor id", apply: (r) => void (r.actor = { ...r.actor, id: testUuid("intruder") }) },
  { name: "occurredAt", apply: (r) => void (r.occurredAt = new Date(r.occurredAt.getTime() + 1)) },
  { name: "recordedAt", apply: (r) => void (r.recordedAt = new Date(r.recordedAt.getTime() - 1)) },
  { name: "orgId", apply: (r) => void (r.orgId = testUuid("other-org")) },
  { name: "engagementId", apply: (r) => void (r.engagementId = testUuid("other-engagement")) },
  { name: "schemaVersion", apply: (r) => void (r.schemaVersion = 2) },
  { name: "hash", apply: (r) => void (r.hash = sha256Hex("forged")) },
];

describe("hash chain", () => {
  it("genesis prev_hash is 64 zeros", () => {
    expect(GENESIS_PREV_HASH).toBe("0".repeat(64));
  });

  it("hashes exactly the §4 fields", () => {
    const e = sampleLog()[0]!;
    const expected = sha256Hex(
      canonicalJson({
        v: 1,
        org_id: e.orgId,
        engagement_id: e.engagementId,
        seq: 1,
        type: "engagement_created",
        schema_version: 1,
        payload: e.payload,
        actor: { type: "user", id: e.actor.id },
        occurred_at: e.occurredAt.toISOString(),
        recorded_at: e.recordedAt.toISOString(),
        prev_hash: GENESIS_PREV_HASH,
      }),
    );
    expect(e.hash).toBe(expected);
    expect(computeEventHash(e)).toBe(expected);
  });

  it("verifies a valid log", () => {
    const log = sampleLog();
    expect(verifyChain(log)).toEqual({ ok: true, checked: log.length, headSeq: log.length, headHash: log[log.length - 1]!.hash });
    expect(verifyChain(log, { seq: log.length, hash: log[log.length - 1]!.hash }).ok).toBe(true);
    expect(verifyChain(log, { seq: 3, hash: log[2]!.hash }).ok).toBe(true);
    expect(verifyChain(log, { seq: 0, hash: GENESIS_PREV_HASH }).ok).toBe(true);
    expect(verifyChain(log, null).ok).toBe(true);
  });

  it("verifies an empty log", () => {
    expect(verifyChain([])).toEqual({ ok: true, checked: 0, headSeq: 0, headHash: GENESIS_PREV_HASH });
  });

  describe("detects any single-field mutation of any event", () => {
    const log = sampleLog();
    for (const m of mutations) {
      it(m.name, () => {
        for (let i = 0; i < log.length; i++) {
          const rows = cloneRows(log);
          m.apply(rows[i]!);
          const result = verifyChain(rows);
          expect(result.ok, `${m.name} at seq ${i + 1}`).toBe(false);
          expect(result.reason).toBe("hash_mismatch");
          expect(result.firstBadSeq).toBe(i + 1);
          expect(result.checked).toBe(i);
          expect(result.headSeq).toBe(i);
          expect(result.headHash).toBe(i === 0 ? GENESIS_PREV_HASH : log[i - 1]!.hash);
        }
      });
    }

    it("seq", () => {
      for (let i = 0; i < log.length; i++) {
        const rows = cloneRows(log);
        rows[i]!.seq += 1;
        expect(verifyChain(rows)).toMatchObject({ ok: false, reason: "seq_gap", firstBadSeq: i + 1 });
      }
    });

    it("prev_hash", () => {
      for (let i = 0; i < log.length; i++) {
        const rows = cloneRows(log);
        rows[i]!.prevHash = sha256Hex("other");
        expect(verifyChain(rows)).toMatchObject({ ok: false, reason: "prev_hash_mismatch", firstBadSeq: i + 1 });
      }
    });
  });

  it("detects an edit whose own hash was recomputed at the next link", () => {
    const rows = cloneRows(sampleLog());
    const target = rows[3]!;
    mutateFirstLeaf(target.payload);
    target.hash = computeEventHash(target);
    expect(verifyChain(rows)).toMatchObject({ ok: false, reason: "prev_hash_mismatch", firstBadSeq: 5 });
  });

  it("detects reordering and gaps", () => {
    const log = sampleLog();
    const swapped = [...log];
    [swapped[2], swapped[3]] = [swapped[3]!, swapped[2]!];
    expect(verifyChain(swapped)).toMatchObject({ ok: false, reason: "seq_gap", firstBadSeq: 3, checked: 2 });
    const gap = log.filter((e) => e.seq !== 4);
    expect(verifyChain(gap)).toMatchObject({ ok: false, reason: "seq_gap", firstBadSeq: 4 });
    expect(verifyChain(log.slice(1))).toMatchObject({ ok: false, reason: "seq_gap", firstBadSeq: 1 });
    expect(verifyChain([...log, log[log.length - 1]!])).toMatchObject({ ok: false, reason: "seq_gap", firstBadSeq: log.length + 1 });
  });

  it("detects tail truncation against a known head", () => {
    const log = sampleLog();
    const head = { seq: log.length, hash: log[log.length - 1]!.hash };
    const truncated = log.slice(0, -2);
    expect(verifyChain(truncated).ok).toBe(true);
    expect(verifyChain(truncated, head)).toEqual({
      ok: false,
      checked: log.length - 2,
      headSeq: log.length - 2,
      headHash: log[log.length - 3]!.hash,
      firstBadSeq: log.length - 1,
      reason: "truncated",
    });
    expect(verifyChain([], head)).toMatchObject({ ok: false, reason: "truncated", firstBadSeq: 1 });
  });

  it("detects a rewritten (diverging) chain against a known head", () => {
    const log = sampleLog();
    const head = { seq: 6, hash: log[5]!.hash };
    // Rebuild the chain from seq 5 with a changed payload and consistent hashes.
    const forged = chainDrafts(
      log.slice(4).map((e, i) => {
        const draft = { type: e.type, payload: structuredClone(e.payload), actor: e.actor, occurredAt: e.occurredAt } as EventDraft;
        if (i === 0) mutateFirstLeaf(draft.payload);
        return draft;
      }),
      {
        orgId: log[0]!.orgId,
        engagementId: log[0]!.engagementId,
        clock: (() => {
          let i = 4;
          return () => log[i++]!.recordedAt;
        })(),
        head: { seq: 4, hash: log[3]!.hash, recordedAt: log[3]!.recordedAt },
      },
    );
    const rewritten = [...log.slice(0, 4), ...forged];
    expect(verifyChain(rewritten).ok).toBe(true);
    expect(verifyChain(rewritten, head)).toMatchObject({ ok: false, reason: "truncated", firstBadSeq: 6, checked: log.length });
    expect(verifyChain(rewritten, { seq: 4, hash: log[3]!.hash }).ok).toBe(true);
  });

  it("reports hash_mismatch instead of throwing on unhashable rows", () => {
    const rows = cloneRows(sampleLog());
    rows[1]!.occurredAt = new Date(Number.NaN);
    expect(verifyChain(rows)).toMatchObject({ ok: false, reason: "hash_mismatch", firstBadSeq: 2 });
    const rows2 = cloneRows(sampleLog());
    (rows2[1]!.payload as Record<string, unknown>).bad = 0.5;
    expect(verifyChain(rows2)).toMatchObject({ ok: false, reason: "hash_mismatch", firstBadSeq: 2 });
  });
});

describe("sealing drafts", () => {
  const ctx = { orgId: testUuid("o"), engagementId: testUuid("e"), seq: 1, prevHash: GENESIS_PREV_HASH, recordedAt: new Date("2026-03-02T10:00:00.123Z") };
  const actor = { type: "user" as const, id: testUuid("u") };

  it("uses recorded_at as occurred_at except for source and item-version events", () => {
    const said = new Date("2026-02-01T09:00:00.000Z");
    const erased = sealEvent({ type: "contact_erased", actor, payload: { contact_id: testUuid("c") }, occurredAt: said }, ctx);
    expect(erased.occurredAt).toEqual(ctx.recordedAt);
    expect(resolveOccurredAt({ type: "item_created", occurredAt: said }, ctx.recordedAt)).toEqual(said);
    expect(resolveOccurredAt({ type: "item_revised", occurredAt: said }, ctx.recordedAt)).toEqual(said);
    expect(resolveOccurredAt({ type: "source_ingested", occurredAt: said }, ctx.recordedAt)).toEqual(said);
    expect(resolveOccurredAt({ type: "item_created" }, ctx.recordedAt)).toEqual(ctx.recordedAt);
  });

  it("assigns schema version, copies the payload and verifies", () => {
    const payload = { contact_id: testUuid("c") };
    const e = sealEvent({ type: "contact_erased", actor, payload }, ctx);
    payload.contact_id = testUuid("changed");
    expect(e.payload).toEqual({ contact_id: testUuid("c") });
    expect(e.schemaVersion).toBe(1);
    expect(verifyChain([e]).ok).toBe(true);
  });

  it("recorded_at never goes backwards and is ms precise", () => {
    const head = new Date("2026-03-02T10:00:00.500Z");
    expect(nextRecordedAt(new Date("2026-03-02T10:00:00.100Z"), head)).toEqual(head);
    expect(nextRecordedAt(new Date("2026-03-02T10:00:01.000Z"), head)).toEqual(new Date("2026-03-02T10:00:01.000Z"));
    expect(nextRecordedAt(new Date("2026-03-02T10:00:01.000Z"), null)).toEqual(new Date("2026-03-02T10:00:01.000Z"));
    expect(() => nextRecordedAt(new Date(Number.NaN), null)).toThrow(RangeError);
  });
});
