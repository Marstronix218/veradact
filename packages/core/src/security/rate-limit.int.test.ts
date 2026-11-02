import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { rateLimitBucket } from "@veradact/db";
import { adminTestDb, testDb } from "@veradact/db/testing";
import { checkRateLimit, pruneRateLimitBuckets, rateLimitKey } from "./rate-limit";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

// A fixed instant 10 s into a 60 s window.
const base = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 10_000);
const at = (ms: number) => new Date(base.getTime() + ms);

describe("checkRateLimit", () => {
  it("allows up to the limit per window, then blocks until the window ends", async () => {
    const id = `ip-${randomUUID()}`;
    const input = { scope: "magic_link_ip" as const, id, limit: 3, windowSeconds: 60 };
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await checkRateLimit(app.db, { ...input, now: at(i * 1000) }));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    expect(results[3]?.retryAfterSeconds).toBe(47); // window ends 50 s after base; 3 s elapsed
    expect(results.slice(0, 3).every((r) => r.retryAfterSeconds === 0)).toBe(true);

    const nextWindow = await checkRateLimit(app.db, { ...input, now: at(50_000) });
    expect(nextWindow).toEqual({ allowed: true, remaining: 2, retryAfterSeconds: 0 });
  });

  it("separates scopes, identifiers and window lengths", async () => {
    const id = `id-${randomUUID()}`;
    const now = at(0);
    await checkRateLimit(app.db, { scope: "mcp_ip", id, limit: 1, windowSeconds: 60, now });
    expect((await checkRateLimit(app.db, { scope: "mcp_token", id, limit: 1, windowSeconds: 60, now })).allowed).toBe(true);
    expect((await checkRateLimit(app.db, { scope: "mcp_ip", id: `${id}x`, limit: 1, windowSeconds: 60, now })).allowed).toBe(true);
    expect((await checkRateLimit(app.db, { scope: "mcp_ip", id, limit: 1, windowSeconds: 120, now })).allowed).toBe(true);
    expect((await checkRateLimit(app.db, { scope: "mcp_ip", id, limit: 1, windowSeconds: 60, now })).allowed).toBe(false);
  });

  it("counts atomically under concurrency", async () => {
    const id = `ip-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        checkRateLimit(app.db, { scope: "client_page_ip", id, limit: 4, windowSeconds: 60, now: at(0) }),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(4);
  });

  it("stores only a hash of the key", async () => {
    const id = `ada-${randomUUID()}@example.test`;
    await checkRateLimit(app.db, { scope: "magic_link_email", id, limit: 5, windowSeconds: 60, now: at(0) });
    const rows = await admin.db
      .select()
      .from(rateLimitBucket)
      .where(eq(rateLimitBucket.key, rateLimitKey("magic_link_email", 60, id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.key).not.toContain(id);
    expect(rows[0]?.count).toBe(1);
  });

  it("rejects nonsensical limits", async () => {
    await expect(
      checkRateLimit(app.db, { scope: "mcp_ip", id: "x", limit: 0, windowSeconds: 60, now: at(0) }),
    ).rejects.toThrow(/limit/);
    await expect(
      checkRateLimit(app.db, { scope: "mcp_ip", id: "x", limit: 1, windowSeconds: 0, now: at(0) }),
    ).rejects.toThrow(/windowSeconds/);
  });
});

describe("pruneRateLimitBuckets", () => {
  it("deletes windows that started before the cutoff and keeps newer ones", async () => {
    const id = `ip-${randomUUID()}`;
    const old = new Date("2001-01-01T00:00:00.000Z");
    await checkRateLimit(app.db, { scope: "mcp_ip", id, limit: 5, windowSeconds: 60, now: old });
    await checkRateLimit(app.db, { scope: "mcp_ip", id, limit: 5, windowSeconds: 60, now: at(0) });
    const key = rateLimitKey("mcp_ip", 60, id);

    const removed = await pruneRateLimitBuckets(app.db, new Date("2001-01-02T00:00:00.000Z"));
    expect(removed).toBeGreaterThanOrEqual(1);
    const rows = await admin.db.select().from(rateLimitBucket).where(eq(rateLimitBucket.key, key));
    expect(rows.map((r) => r.windowStart.getTime())).toEqual([Math.floor(base.getTime() / 60_000) * 60_000]);
  });
});
