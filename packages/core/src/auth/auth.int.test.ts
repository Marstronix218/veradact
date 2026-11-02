// Magic-link login and sessions against real Postgres as the app role.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { appUser, auditLog, loginToken, rateLimitBucket, session } from "@veradact/db";
import { adminTestDb, createTestTenant, createTestUser, testDb } from "@veradact/db/testing";
import { MemoryEmailProvider } from "@veradact/email";
import { rateLimitKey } from "../security/rate-limit";
import { hashToken } from "../security/tokens";
import { LOGIN_TOKEN_TTL_MS, MAGIC_LINK_RATE_LIMITS, requestMagicLink, verifyMagicLink } from "./magic-link";
import { logout, resolveSession, SESSION_TTL_MS } from "./session";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

const APP_URL = "http://app.test/";
const clock = () => new Date();
const freshIp = () => `198.51.100.${randomUUID()}`;
const unknownEmail = () => `nobody-${randomUUID()}@example.test`;

function tokenFromMail(mail: MemoryEmailProvider, to: string): string {
  const text = mail.lastTo(to)?.text ?? "";
  const match = /http:\/\/app\.test\/auth\/verify\?token=([A-Za-z0-9_-]+)/.exec(text);
  if (!match?.[1]) throw new Error("no sign-in link in the message");
  return match[1];
}

async function requestLink(email: string, mail = new MemoryEmailProvider(), now = clock) {
  const result = await requestMagicLink({
    db: app.db,
    email,
    clock: now,
    emailProvider: mail,
    appUrl: APP_URL,
    ip: freshIp(),
  });
  return { result, mail };
}

async function login(email: string) {
  const { mail } = await requestLink(email);
  const verified = await verifyMagicLink({ db: app.db, token: tokenFromMail(mail, email), clock, ip: freshIp() });
  if (verified.status !== "ok") throw new Error(`login failed: ${verified.status}`);
  return verified;
}

describe("requestMagicLink", () => {
  it("emails a link for a known user (any case) and stores only the token hash", async () => {
    const { org, user } = await createTestTenant(admin.db);
    const before = Date.now();
    const { result, mail } = await requestLink(`  ${user.email.toUpperCase()} `);
    expect(result).toEqual({ status: "accepted" });

    const message = mail.lastTo(user.email);
    expect(message?.subject).toBe("Your Veradact sign-in link");
    expect(message?.tags).toEqual({ kind: "magic_link" });
    const token = tokenFromMail(mail, user.email);

    const rows = await admin.db.select().from(loginToken).where(eq(loginToken.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orgId: org.id, tokenHash: hashToken(token), usedAt: null });
    expect(rows[0]?.tokenHash).not.toContain(token);
    const ttl = rows[0]!.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(LOGIN_TOKEN_TTL_MS - 1000);
    expect(ttl).toBeLessThanOrEqual(LOGIN_TOKEN_TTL_MS + 5000);
  });

  it("returns the same result for unknown addresses, sends nothing and creates no token", async () => {
    const { user } = await createTestTenant(admin.db);
    const nobody = unknownEmail();
    const mail = new MemoryEmailProvider();
    const deferred: (() => Promise<void>)[] = [];
    const run = (email: string) =>
      requestMagicLink({
        db: app.db,
        email,
        clock,
        emailProvider: mail,
        appUrl: APP_URL,
        ip: freshIp(),
        defer: (task) => deferred.push(task),
      });

    const known = await run(user.email);
    const unknown = await run(nobody);
    expect(unknown).toEqual(known);
    // With `defer`, nothing is delivered before the response in either case.
    expect(mail.messages).toHaveLength(0);

    // Both addresses were charged against the per-email limit (same path up to the lookup).
    const { windowSeconds } = MAGIC_LINK_RATE_LIMITS.perEmail;
    for (const email of [user.email, nobody]) {
      const buckets = await admin.db
        .select()
        .from(rateLimitBucket)
        .where(eq(rateLimitBucket.key, rateLimitKey("magic_link_email", windowSeconds, email)));
      expect(buckets.map((b) => b.count)).toEqual([1]);
    }

    for (const task of deferred) await task();
    expect(mail.messages.map((m) => m.to)).toEqual([user.email]);
    const tokens = await admin.db.select().from(loginToken).where(eq(loginToken.userId, user.id));
    expect(tokens).toHaveLength(1);
  });

  it("does not issue links to deactivated users", async () => {
    const { org } = await createTestTenant(admin.db);
    const gone = await createTestUser(admin.db, { orgId: org.id, deactivatedAt: new Date() });
    const { result, mail } = await requestLink(gone.email);
    expect(result).toEqual({ status: "accepted" });
    expect(mail.messages).toHaveLength(0);
  });

  it("rejects malformed addresses", async () => {
    for (const email of ["", "ada", "ada@example", "a b@example.test", "a@b.test, c@d.test"]) {
      expect((await requestLink(email)).result).toEqual({ status: "invalid_email" });
    }
  });

  it("rate limits per email address", async () => {
    const email = unknownEmail();
    const { limit } = MAGIC_LINK_RATE_LIMITS.perEmail;
    for (let i = 0; i < limit; i++) expect((await requestLink(email)).result.status).toBe("accepted");
    const blocked = (await requestLink(email.toUpperCase())).result;
    expect(blocked.status).toBe("rate_limited");
    expect(blocked.status === "rate_limited" && blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("rate limits per IP", async () => {
    const ip = freshIp();
    const { limit } = MAGIC_LINK_RATE_LIMITS.perIp;
    const send = () =>
      requestMagicLink({ db: app.db, email: unknownEmail(), clock, emailProvider: new MemoryEmailProvider(), appUrl: APP_URL, ip });
    for (let i = 0; i < limit; i++) expect((await send()).status).toBe("accepted");
    expect((await send()).status).toBe("rate_limited");
  });

  it("logs delivery failures instead of failing the request", async () => {
    const { user } = await createTestTenant(admin.db);
    const failing = { name: "failing", send: async () => Promise.reject(new Error("smtp down")) };
    const result = await requestMagicLink({ db: app.db, email: user.email, clock, emailProvider: failing, appUrl: APP_URL, ip: freshIp() });
    expect(result).toEqual({ status: "accepted" });
  });
});

describe("verifyMagicLink", () => {
  it("opens a session once per link and audits auth.login", async () => {
    const { org, user } = await createTestTenant(admin.db);
    const { mail } = await requestLink(user.email);
    const token = tokenFromMail(mail, user.email);

    const first = await verifyMagicLink({ db: app.db, token, clock, ip: freshIp() });
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;
    expect(first.user).toEqual({ id: user.id, email: user.email, name: user.name, role: "admin" });
    expect(first.session).toMatchObject({ orgId: org.id, userId: user.id, role: "admin" });
    expect(first.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.expiresAt.getTime() - Date.now()).toBeGreaterThan(SESSION_TTL_MS - 60_000);

    const [stored] = await admin.db.select().from(session).where(eq(session.id, first.session.sessionId));
    expect(stored?.tokenHash).toBe(hashToken(first.sessionToken));

    const audits = await admin.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, org.id), eq(auditLog.action, "auth.login")));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: user.id,
      targetType: "session",
      targetId: first.session.sessionId,
      metadata: { method: "magic_link" },
    });

    expect(await verifyMagicLink({ db: app.db, token, clock, ip: freshIp() })).toEqual({ status: "invalid" });
  });

  it("rejects expired links", async () => {
    const { user } = await createTestTenant(admin.db);
    // Issued 16 minutes ago: expired 1 minute ago by the database clock.
    const { mail } = await requestLink(user.email, new MemoryEmailProvider(), () => new Date(Date.now() - 16 * 60_000));
    const result = await verifyMagicLink({ db: app.db, token: tokenFromMail(mail, user.email), clock, ip: freshIp() });
    expect(result).toEqual({ status: "invalid" });
  });

  it("rejects links of users deactivated after the link was sent", async () => {
    const { user } = await createTestTenant(admin.db);
    const { mail } = await requestLink(user.email);
    await admin.db.update(appUser).set({ deactivatedAt: new Date() }).where(eq(appUser.id, user.id));
    const result = await verifyMagicLink({ db: app.db, token: tokenFromMail(mail, user.email), clock, ip: freshIp() });
    expect(result).toEqual({ status: "invalid" });
  });

  it("rejects malformed and unknown tokens", async () => {
    for (const token of [undefined, null, "", "abc", "x".repeat(43)]) {
      expect(await verifyMagicLink({ db: app.db, token, clock, ip: freshIp() })).toEqual({ status: "invalid" });
    }
  });

  it("rate limits verification attempts per IP", async () => {
    const ip = freshIp();
    const { limit } = MAGIC_LINK_RATE_LIMITS.verifyPerIp;
    for (let i = 0; i < limit; i++) {
      expect((await verifyMagicLink({ db: app.db, token: "x".repeat(43), clock, ip })).status).toBe("invalid");
    }
    expect((await verifyMagicLink({ db: app.db, token: "x".repeat(43), clock, ip })).status).toBe("rate_limited");
  });
});

describe("sessions", () => {
  it("resolves a live session to its org, user and role", async () => {
    const { org, user } = await createTestTenant(admin.db);
    const login1 = await login(user.email);
    const resolved = await resolveSession({ db: app.db, token: login1.sessionToken, clock });
    expect(resolved).toEqual({
      sessionId: login1.session.sessionId,
      orgId: org.id,
      userId: user.id,
      role: "admin",
      expiresAt: login1.expiresAt,
    });
  });

  it("writes last_seen_at at most every 5 minutes", async () => {
    const { user } = await createTestTenant(admin.db);
    const { sessionToken, session: s } = await login(user.email);
    const lastSeen = async () =>
      (await admin.db.select().from(session).where(eq(session.id, s.sessionId)))[0]?.lastSeenAt?.getTime();
    const created = await lastSeen();
    expect(created).toBeDefined();

    const in1 = new Date(created! + 60_000);
    await resolveSession({ db: app.db, token: sessionToken, clock: () => in1 });
    expect(await lastSeen()).toBe(created);

    const in6 = new Date(created! + 6 * 60_000);
    await resolveSession({ db: app.db, token: sessionToken, clock: () => in6 });
    expect(await lastSeen()).toBe(in6.getTime());

    await resolveSession({ db: app.db, token: sessionToken, clock: () => new Date(in6.getTime() + 4 * 60_000) });
    expect(await lastSeen()).toBe(in6.getTime());
  });

  it("does not resolve expired sessions", async () => {
    const { user } = await createTestTenant(admin.db);
    const { sessionToken, session: s } = await login(user.email);
    await admin.db.update(session).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(session.id, s.sessionId));
    expect(await resolveSession({ db: app.db, token: sessionToken, clock })).toBeNull();
  });

  it("does not resolve sessions of deactivated users", async () => {
    const { user } = await createTestTenant(admin.db);
    const { sessionToken } = await login(user.email);
    await admin.db.update(appUser).set({ deactivatedAt: new Date() }).where(eq(appUser.id, user.id));
    expect(await resolveSession({ db: app.db, token: sessionToken, clock })).toBeNull();
  });

  it("ignores missing and malformed cookies", async () => {
    for (const token of [undefined, null, "", "garbage", "y".repeat(43)]) {
      expect(await resolveSession({ db: app.db, token, clock })).toBeNull();
    }
  });

  it("logout revokes the session and audits auth.logout", async () => {
    const { org, user } = await createTestTenant(admin.db);
    const { sessionToken, session: s } = await login(user.email);
    const other = await login(user.email);

    expect(await logout({ db: app.db, token: sessionToken, clock })).toBe(true);
    expect(await resolveSession({ db: app.db, token: sessionToken, clock })).toBeNull();
    expect(await logout({ db: app.db, token: sessionToken, clock })).toBe(false);
    // Other sessions of the same user stay live.
    expect(await resolveSession({ db: app.db, token: other.sessionToken, clock })).not.toBeNull();

    const audits = await admin.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, org.id), eq(auditLog.action, "auth.logout")));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorUserId: user.id, targetType: "session", targetId: s.sessionId });
  });
});
