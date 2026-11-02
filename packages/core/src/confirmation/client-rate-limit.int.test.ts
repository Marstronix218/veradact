// Client-page rate limits (ARCHITECTURE §14, D-049): per IP and per link, both charged on every
// GET and POST of /c/<token>. Keys are unique per test, so the shared database cannot collide.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { testDb } from "@veradact/db/testing";
import { CLIENT_PAGE_RATE_LIMITS, checkClientPageRateLimit } from "./client-actions";

const app = testDb();

afterAll(async () => {
  await app.close();
});

// 10 s into a 15-minute window, so a run never straddles a window boundary.
const windowMs = CLIENT_PAGE_RATE_LIMITS.perIp.windowSeconds * 1000;
const now = new Date(Math.floor(Date.now() / windowMs) * windowMs + 10_000);

describe("checkClientPageRateLimit", () => {
  it("limits one IP across many links", async () => {
    const ip = `ip-${randomUUID()}`;
    const { limit } = CLIENT_PAGE_RATE_LIMITS.perIp;
    for (let i = 0; i < limit; i++) expect((await checkClientPageRateLimit(app.db, { ip, linkKey: randomUUID(), now })).allowed).toBe(true);
    const blocked = await checkClientPageRateLimit(app.db, { ip, linkKey: randomUUID(), now });
    expect(blocked).toEqual({ allowed: false, retryAfterSeconds: CLIENT_PAGE_RATE_LIMITS.perIp.windowSeconds - 10 });
    // Another address is unaffected.
    expect((await checkClientPageRateLimit(app.db, { ip: `ip-${randomUUID()}`, linkKey: randomUUID(), now })).allowed).toBe(true);
  });

  it("limits one link across many IPs", async () => {
    const linkKey = randomUUID();
    const { limit } = CLIENT_PAGE_RATE_LIMITS.perLink;
    for (let i = 0; i < limit; i++) expect((await checkClientPageRateLimit(app.db, { ip: `ip-${randomUUID()}`, linkKey, now })).allowed).toBe(true);
    expect((await checkClientPageRateLimit(app.db, { ip: `ip-${randomUUID()}`, linkKey, now })).allowed).toBe(false);
    expect((await checkClientPageRateLimit(app.db, { ip: `ip-${randomUUID()}`, linkKey: randomUUID(), now })).allowed).toBe(true);
    // The next window starts fresh.
    expect((await checkClientPageRateLimit(app.db, { ip: `ip-${randomUUID()}`, linkKey, now: new Date(now.getTime() + windowMs) })).allowed).toBe(true);
  });
});
