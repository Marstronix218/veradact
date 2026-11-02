// Append API (ARCHITECTURE §5.2) against real Postgres as the app role: sequencing, recorded_at,
// validation, the advisory lock under concurrency, RLS through the store, and invariant 1
// (append-only) asserted through the same tenant transactions the store uses.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { event, withTenant } from "@veradact/db";
import { adminTestDb, catchPgError, createTestEngagement, testDb } from "@veradact/db/testing";
import { emptyState, fold, GENESIS_PREV_HASH, projectRows, type EventDraft } from "../domain";
import { clockFrom, steppingClock } from "../domain/testing";
import { DomainError } from "../errors";
import { createLedgerTenant } from "../test-support/ledger";
import { appendEvents, dumpProjections, loadState, readEvents, verifyEngagementChain } from "./index";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

async function freshEngagement() {
  const tenant = await createLedgerTenant(admin.db);
  const row = await createTestEngagement(admin.db, { orgId: tenant.orgId, createdBy: tenant.userId, shortCode: "TEST" });
  const genesis: EventDraft = {
    type: "engagement_created",
    actor: { type: "user", id: tenant.userId },
    payload: { engagement_id: row.id, short_code: "TEST", name: "Synthetic engagement", client_name: "Fictional Client Co", time_zone: "UTC" },
  };
  const rename = (name: string): EventDraft => ({ type: "engagement_updated", actor: { type: "user", id: tenant.userId }, payload: { name } });
  const manualItem = (n: number): EventDraft => ({
    type: "item_created",
    actor: { type: "user", id: tenant.userId },
    payload: {
      item_id: randomUUID(),
      short_id: `TEST-R${n}`,
      kind: "requirement",
      version: 1,
      statement: `Requirement ${n}`,
      spans: [],
      manual: { entered_by: tenant.userId },
      depends_on: [],
      provenance: { via: "manual" },
      // Hash correctness is the commands' job; the store only needs a well-formed digest.
      content_hash: "a".repeat(64),
    },
  });
  return { ...tenant, engagementId: row.id, genesis, rename, manualItem };
}

describe("appendEvents", () => {
  it("assigns seq, prev_hash, recorded_at and hashes, and returns the folded state", async () => {
    const e = await freshEngagement();
    const clock = steppingClock(new Date("2026-03-02T15:00:00.123Z"), 250);
    const result = await withTenant(app.db, { orgId: e.orgId }, (tx) =>
      appendEvents(tx, e.engagementId, [e.genesis, e.rename("Renamed"), e.manualItem(1)], { clock }),
    );
    expect(result.events.map((ev) => ev.seq)).toEqual([1, 2, 3]);
    expect(result.events[0]!.prevHash).toBe(GENESIS_PREV_HASH);
    expect(result.events[1]!.prevHash).toBe(result.events[0]!.hash);
    expect(result.events[2]!.prevHash).toBe(result.events[1]!.hash);
    expect(result.events.map((ev) => ev.recordedAt.toISOString())).toEqual([
      "2026-03-02T15:00:00.123Z",
      "2026-03-02T15:00:00.373Z",
      "2026-03-02T15:00:00.623Z",
    ]);
    expect(result.eventIds).toHaveLength(3);
    expect(result.state.engagement?.name).toBe("Renamed");
    expect(result.state.headSeq).toBe(3);

    await withTenant(app.db, { orgId: e.orgId }, async (tx) => {
      const stored = await readEvents(tx, e.engagementId);
      expect(stored).toEqual(result.events);
      expect(await loadState(tx, e.engagementId)).toEqual(result.state);
      expect(await dumpProjections(tx, e.engagementId)).toEqual(projectRows(result.state));
      expect((await verifyEngagementChain(tx, e.engagementId)).ok).toBe(true);
    });
  });

  it("never lets recorded_at go backwards when the clock does, and truncates to milliseconds", async () => {
    const e = await freshEngagement();
    const times = [new Date("2026-03-02T15:00:05.000Z"), new Date("2026-03-02T15:00:01.000Z"), new Date(Date.UTC(2026, 2, 2, 15, 0, 9) + 0.75)];
    const result = await withTenant(app.db, { orgId: e.orgId }, (tx) =>
      appendEvents(tx, e.engagementId, [e.genesis, e.rename("A"), e.rename("B")], { clock: clockFrom(times) }),
    );
    expect(result.events.map((ev) => ev.recordedAt.toISOString())).toEqual([
      "2026-03-02T15:00:05.000Z",
      "2026-03-02T15:00:05.000Z",
      "2026-03-02T15:00:09.000Z",
    ]);
    // occurred_at = recorded_at for events that are not source/item-version events.
    expect(result.events.every((ev) => ev.occurredAt.getTime() === ev.recordedAt.getTime())).toBe(true);
  });

  it("calls the clock exactly once per draft", async () => {
    const e = await freshEngagement();
    let calls = 0;
    const clock = () => {
      calls += 1;
      return new Date("2026-03-02T15:00:00.000Z");
    };
    await withTenant(app.db, { orgId: e.orgId }, (tx) => appendEvents(tx, e.engagementId, [e.genesis, e.rename("A"), e.rename("B")], { clock }));
    expect(calls).toBe(3);
  });

  it("rejects an invalid draft with invalid_event and writes nothing", async () => {
    const e = await freshEngagement();
    const clock = steppingClock(new Date("2026-03-02T15:00:00.000Z"));
    await withTenant(app.db, { orgId: e.orgId }, (tx) => appendEvents(tx, e.engagementId, [e.genesis], { clock }));
    const bad = { type: "engagement_updated", actor: { type: "user", id: e.userId }, payload: { name: "" } } as EventDraft;
    const error = await withTenant(app.db, { orgId: e.orgId }, (tx) =>
      appendEvents(tx, e.engagementId, [e.rename("ok"), bad], { clock }),
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("invalid_event");
    expect((error as DomainError).message).not.toContain("ok");
    const stored = await withTenant(app.db, { orgId: e.orgId }, (tx) => readEvents(tx, e.engagementId));
    expect(stored).toHaveLength(1);
  });

  it("requires engagement_created as the genesis event and only there", async () => {
    const e = await freshEngagement();
    const clock = steppingClock(new Date("2026-03-02T15:00:00.000Z"));
    const first = await withTenant(app.db, { orgId: e.orgId }, (tx) => appendEvents(tx, e.engagementId, [e.rename("A")], { clock })).catch(
      (err: unknown) => err,
    );
    expect((first as DomainError).code).toBe("invalid_event");
    await withTenant(app.db, { orgId: e.orgId }, (tx) => appendEvents(tx, e.engagementId, [e.genesis], { clock }));
    const second = await withTenant(app.db, { orgId: e.orgId }, (tx) => appendEvents(tx, e.engagementId, [e.genesis], { clock })).catch(
      (err: unknown) => err,
    );
    expect((second as DomainError).code).toBe("invalid_event");
  });

  it("ignores a caller-supplied state that is behind the stored head", async () => {
    const e = await freshEngagement();
    const clock = steppingClock(new Date("2026-03-02T15:00:00.000Z"));
    const first = await withTenant(app.db, { orgId: e.orgId }, (tx) => appendEvents(tx, e.engagementId, [e.genesis], { clock }));
    await withTenant(app.db, { orgId: e.orgId }, (tx) => appendEvents(tx, e.engagementId, [e.rename("B")], { clock }));
    const third = await withTenant(app.db, { orgId: e.orgId }, (tx) =>
      appendEvents(tx, e.engagementId, [e.rename("C")], { clock, state: first.state }),
    );
    expect(third.events[0]!.seq).toBe(3);
    expect(third.state.engagement?.name).toBe("C");
  });

  it("returns the current state for an empty batch without writing", async () => {
    const e = await freshEngagement();
    const clock = steppingClock(new Date("2026-03-02T15:00:00.000Z"));
    await withTenant(app.db, { orgId: e.orgId }, (tx) => appendEvents(tx, e.engagementId, [e.genesis], { clock }));
    const result = await withTenant(app.db, { orgId: e.orgId }, (tx) => appendEvents(tx, e.engagementId, [], { clock }));
    expect(result.events).toEqual([]);
    expect(result.state.headSeq).toBe(1);
  });
});

describe("concurrency: the engagement advisory lock", () => {
  it("serializes two parallel appends to one engagement into consecutive seqs", async () => {
    const e = await freshEngagement();
    const clock = steppingClock(new Date("2026-03-02T15:00:00.000Z"));
    await withTenant(app.db, { orgId: e.orgId }, (tx) => appendEvents(tx, e.engagementId, [e.genesis], { clock }));

    // The first writer holds the lock (and its transaction) open for a while after appending.
    const slow = withTenant(app.db, { orgId: e.orgId }, async (tx) => {
      const r = await appendEvents(tx, e.engagementId, [e.manualItem(1)], { clock });
      await tx.execute(sql`select pg_sleep(0.3)`);
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fast = withTenant(app.db, { orgId: e.orgId }, (tx) => appendEvents(tx, e.engagementId, [e.manualItem(2)], { clock }));
    const [a, b] = await Promise.all([slow, fast]);

    const [second, third] = [a.events[0]!, b.events[0]!].sort((x, y) => x.seq - y.seq);
    expect([second!.seq, third!.seq]).toEqual([2, 3]);
    expect(third!.prevHash).toBe(second!.hash);
    await withTenant(app.db, { orgId: e.orgId }, async (tx) => {
      expect((await verifyEngagementChain(tx, e.engagementId)).ok).toBe(true);
      const state = await loadState(tx, e.engagementId);
      expect(state.items.size).toBe(2);
      expect(await dumpProjections(tx, e.engagementId)).toEqual(projectRows(state));
    });
  });
});

describe("tenant isolation through the store (invariant 7)", () => {
  it("org A cannot load, verify or append to org B's engagement", async () => {
    const b = await freshEngagement();
    const clock = steppingClock(new Date("2026-03-02T15:00:00.000Z"));
    await withTenant(app.db, { orgId: b.orgId }, (tx) => appendEvents(tx, b.engagementId, [b.genesis, b.rename("B")], { clock }));
    const a = await createLedgerTenant(admin.db);

    await withTenant(app.db, { orgId: a.orgId }, async (tx) => {
      expect(await readEvents(tx, b.engagementId)).toEqual([]);
      expect(await loadState(tx, b.engagementId)).toEqual(emptyState());
      const verification = await verifyEngagementChain(tx, b.engagementId);
      expect(verification.checked).toBe(0);
      const rows = await dumpProjections(tx, b.engagementId);
      expect(Object.values(rows).every((r) => r.length === 0)).toBe(true);
    });
    const error = await withTenant(app.db, { orgId: a.orgId }, (tx) =>
      appendEvents(tx, b.engagementId, [b.rename("hijack")], { clock }),
    ).catch((err: unknown) => err);
    expect((error as DomainError).code).toBe("engagement_not_found");

    const stillB = await withTenant(app.db, { orgId: b.orgId }, (tx) => loadState(tx, b.engagementId));
    expect(stillB.headSeq).toBe(2);
    expect(stillB.engagement?.name).toBe("B");
  });
});

describe("append-only through the core path (invariant 1)", () => {
  it("the app role cannot UPDATE, DELETE or TRUNCATE events appended by appendEvents", async () => {
    const e = await freshEngagement();
    const clock = steppingClock(new Date("2026-03-02T15:00:00.000Z"));
    const { eventIds } = await withTenant(app.db, { orgId: e.orgId }, (tx) =>
      appendEvents(tx, e.engagementId, [e.genesis, e.rename("A")], { clock }),
    );
    const id = eventIds[1]!;
    for (const statement of [
      sql`update event set payload = '{"name":"tampered"}'::jsonb where id = ${id}`,
      sql`delete from event where id = ${id}`,
      sql`truncate event`,
    ]) {
      const error = await catchPgError(withTenant(app.db, { orgId: e.orgId }, (tx) => tx.execute(statement)));
      expect(error.code).toBe("42501");
    }
    // Drizzle's query builder goes through the same privileges.
    const viaBuilder = await catchPgError(
      withTenant(app.db, { orgId: e.orgId }, (tx) => tx.update(event).set({ type: "tampered" }).where(eq(event.id, id))),
    );
    expect(viaBuilder.code).toBe("42501");
    await withTenant(app.db, { orgId: e.orgId }, async (tx) => {
      const verification = await verifyEngagementChain(tx, e.engagementId);
      expect(verification).toMatchObject({ ok: true, headSeq: 2 });
      expect(fold(await readEvents(tx, e.engagementId)).engagement?.name).toBe("A");
    });
  });
});
