import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { event } from "./schema";
import { withTenant } from "./tenant";
import { adminTestDb, createTestTenant, insertRawEvents, testDb } from "./testing";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

describe("driver type round-trip", () => {
  it("returns a millisecond Date unchanged from timestamptz(3), via Drizzle and raw SQL", async () => {
    const { org, engagement } = await createTestTenant(admin.db);
    const occurredAt = new Date("2025-12-31T23:59:59.999Z");
    const recordedAt = new Date("2026-03-04T05:06:07.891Z");
    const payload = { nested: { list: [1, 2, 3], text: "x" }, n: 7 };

    await withTenant(app.db, { orgId: org.id }, async (tx) => {
      await insertRawEvents(tx, { orgId: org.id, engagementId: engagement.id }, 1, {
        occurredAt,
        recordedAt,
        payload,
      });

      const [typed] = await tx.select().from(event).where(eq(event.engagementId, engagement.id));
      expect(typed?.recordedAt).toBeInstanceOf(Date);
      expect(typed?.recordedAt.getTime()).toBe(recordedAt.getTime());
      expect(typed?.occurredAt.toISOString()).toBe(occurredAt.toISOString());
      expect(typed?.payload).toEqual(payload);
      expect(typeof typed?.seq).toBe("number");
      expect(typeof typed?.id).toBe("number");

      const raw = await tx.execute<{ id: unknown; seq: unknown; recorded_at: unknown; payload: unknown }>(
        sql`select id, seq, recorded_at, payload from event where engagement_id = ${engagement.id}`,
      );
      const row = raw[0];
      expect(row?.recorded_at).toBeInstanceOf(Date);
      expect((row?.recorded_at as Date).getTime()).toBe(recordedAt.getTime());
      expect(row?.seq).toBe(1);
      expect(typeof row?.id).toBe("number");
      expect(row?.payload).toEqual(payload);
    });
  });

  it("parses int8 and timestamptz in plain postgres.js queries too", async () => {
    const at = new Date("2026-07-08T09:10:11.012Z");
    const [row] = await app.sql<{ big: unknown; at: unknown; doc: unknown }[]>`
      select 9007199254740991::int8 as big, ${at}::timestamptz as at, '{"a":[1]}'::jsonb as doc`;
    expect(row?.big).toBe(Number.MAX_SAFE_INTEGER);
    expect(row?.at).toBeInstanceOf(Date);
    expect((row?.at as Date).getTime()).toBe(at.getTime());
    expect(row?.doc).toEqual({ a: [1] });
  });

  it("returns count(*) as a number", async () => {
    const rows = await app.db.execute<{ n: unknown }>(sql`select count(*) as n from generate_series(1, 3)`);
    expect(rows[0]?.n).toBe(3);
  });
});
