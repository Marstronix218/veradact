// Invariant 3 (hash chain) against real Postgres: a round trip through the append path and the
// export read query re-verifies, and owner-level tampering (triggers off via
// session_replication_role = replica) is detected with the right reason.
import fc from "fast-check";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { event, withTenant } from "@veradact/db";
import { adminTestDb, testDb } from "@veradact/db/testing";
import { computeEventHash, verifyChain, type ChainVerification, type StoredEvent } from "../domain";
import { arbEngagementLog, clockFrom, storedEventsOf, type GeneratedEngagement } from "../domain/testing";
import { insertGeneratedFixtures, tamper } from "../test-support/ledger";
import { appendEvents, readEngagementHead, readEvents, toStoredEvent, verifyEngagementChain } from "./index";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

/** A generated engagement (every event type, shared milliseconds) appended through the store. */
async function appendedEngagement(): Promise<{ gen: GeneratedEngagement; events: StoredEvent[] }> {
  const [gen] = fc.sample(arbEngagementLog({ minOps: 30, maxOps: 40 }), 1);
  if (!gen) throw new Error("no sample");
  const clock = clockFrom(gen.recordedAt);
  const events: StoredEvent[] = [];
  await withTenant(app.db, { orgId: gen.orgId }, async (tx) => {
    await insertGeneratedFixtures(admin.db, tx, gen);
    // Several batches, so heads are re-read between appends.
    for (let i = 0; i < gen.drafts.length; i += 7) {
      events.push(...(await appendEvents(tx, gen.engagementId, gen.drafts.slice(i, i + 7), { clock })).events);
    }
  });
  return { gen, events };
}

function verify(gen: GeneratedEngagement): Promise<ChainVerification> {
  return withTenant(app.db, { orgId: gen.orgId }, (tx) => verifyEngagementChain(tx, gen.engagementId));
}

describe("hash round trip", () => {
  it("events read back through readEvents equal what was appended, re-verify, and match pure sealing", async () => {
    const { gen, events } = await appendedEngagement();
    await withTenant(app.db, { orgId: gen.orgId }, async (tx) => {
      const stored = await readEvents(tx, gen.engagementId);
      expect(stored).toEqual(events);
      // The database round trip (jsonb, timestamptz(3), int8) does not change any hashed value.
      expect(stored).toEqual(storedEventsOf(gen));
      for (const e of stored) expect(computeEventHash(e)).toBe(e.hash);
      const head = await readEngagementHead(tx, gen.engagementId);
      expect(head).toMatchObject({ seq: events.length, hash: events[events.length - 1]!.hash });
      expect(verifyChain(stored, head)).toEqual({ ok: true, checked: events.length, headSeq: events.length, headHash: head!.hash });
      expect(await verifyEngagementChain(tx, gen.engagementId)).toMatchObject({ ok: true, checked: events.length });
      // Replay cut-offs read a prefix.
      expect(await readEvents(tx, gen.engagementId, { throughSeq: 3 })).toEqual(events.slice(0, 3));
      const t = events[5]!.recordedAt;
      expect(await readEvents(tx, gen.engagementId, { recordedAtOrBefore: t })).toEqual(events.filter((e) => e.recordedAt <= t));
    });
  });
});

describe("tamper detection (owner with triggers off)", () => {
  it("a changed payload is a hash_mismatch at that seq", async () => {
    const { gen, events } = await appendedEngagement();
    const seq = Math.floor(events.length / 2);
    await tamper(admin.db, sql`update event set payload = payload || '{"tampered": true}'::jsonb where engagement_id = ${gen.engagementId} and seq = ${seq}`);
    expect(await verify(gen)).toMatchObject({ ok: false, reason: "hash_mismatch", firstBadSeq: seq, checked: seq - 1 });
  });

  it("a changed recorded_at or occurred_at is a hash_mismatch at that seq", async () => {
    const { gen, events } = await appendedEngagement();
    const seq = events.length - 2;
    await tamper(admin.db, sql`update event set recorded_at = recorded_at + interval '1 millisecond' where engagement_id = ${gen.engagementId} and seq = ${seq}`);
    expect(await verify(gen)).toMatchObject({ ok: false, reason: "hash_mismatch", firstBadSeq: seq });

    const other = await appendedEngagement();
    await tamper(admin.db, sql`update event set occurred_at = occurred_at - interval '1 day' where engagement_id = ${other.gen.engagementId} and seq = 2`);
    expect(await verify(other.gen)).toMatchObject({ ok: false, reason: "hash_mismatch", firstBadSeq: 2 });
  });

  it("a changed actor is a hash_mismatch", async () => {
    const { gen } = await appendedEngagement();
    await tamper(admin.db, sql`update event set actor_type = 'system', actor_id = null where engagement_id = ${gen.engagementId} and seq = 1`);
    expect(await verify(gen)).toMatchObject({ ok: false, reason: "hash_mismatch", firstBadSeq: 1 });
  });

  it("a deleted middle event is a seq_gap", async () => {
    const { gen, events } = await appendedEngagement();
    const seq = Math.floor(events.length / 3);
    await tamper(admin.db, sql`delete from event where engagement_id = ${gen.engagementId} and seq = ${seq}`);
    expect(await verify(gen)).toMatchObject({ ok: false, reason: "seq_gap", firstBadSeq: seq, checked: seq - 1 });
  });

  it("a deleted tail is truncated against engagement_head", async () => {
    const { gen, events } = await appendedEngagement();
    const n = events.length;
    await tamper(admin.db, sql`delete from event where engagement_id = ${gen.engagementId} and seq >= ${n - 1}`);
    const result = await verify(gen);
    expect(result).toMatchObject({ ok: false, reason: "truncated", firstBadSeq: n - 1, checked: n - 2 });
    // Without a known head a shortened log is internally consistent — which is why exports and
    // receipts carry the head (ARCHITECTURE §4).
    const internal = await withTenant(app.db, { orgId: gen.orgId }, (tx) => verifyEngagementChain(tx, gen.engagementId, null));
    expect(internal.ok).toBe(true);
  });

  it("a rewritten history with recomputed hashes diverges from the stored and receipted heads", async () => {
    const { gen, events } = await appendedEngagement();
    const receipt = { seq: events.length, hash: events[events.length - 1]!.hash };
    const from = Math.floor(events.length / 2);
    await admin.db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.execute(sql`update event set payload = payload || '{"rewritten": true}'::jsonb where engagement_id = ${gen.engagementId} and seq = ${from}`);
      const rows = await tx.select().from(event).where(eq(event.engagementId, gen.engagementId)).orderBy(asc(event.seq));
      let prevHash = rows[from - 2]!.hash;
      for (const row of rows.slice(from - 1)) {
        const rewritten = { ...toStoredEvent(row), prevHash };
        const hash = computeEventHash(rewritten);
        await tx.update(event).set({ prevHash, hash }).where(eq(event.id, row.id));
        prevHash = hash;
      }
    });
    const internal = await withTenant(app.db, { orgId: gen.orgId }, (tx) => verifyEngagementChain(tx, gen.engagementId, null));
    expect(internal.ok).toBe(true);
    expect(await verify(gen)).toMatchObject({ ok: false, reason: "truncated", firstBadSeq: events.length });
    const againstReceipt = await withTenant(app.db, { orgId: gen.orgId }, (tx) => verifyEngagementChain(tx, gen.engagementId, receipt));
    expect(againstReceipt).toMatchObject({ ok: false, reason: "truncated", firstBadSeq: receipt.seq });
    // An earlier receipt (a prefix before the rewrite) still matches.
    const early = { seq: from - 1, hash: events[from - 2]!.hash };
    expect((await withTenant(app.db, { orgId: gen.orgId }, (tx) => verifyEngagementChain(tx, gen.engagementId, early))).ok).toBe(true);
  });
});
