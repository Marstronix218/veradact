// Self-serve sign-up against real Postgres as the app role.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { appUser, auditLog, org, session } from "@veradact/db";
import { adminTestDb, createTestTenant, testDb } from "@veradact/db/testing";
import { MemoryEmailProvider } from "@veradact/email";
import { ValidationError } from "../errors";
import { hashToken } from "../security/tokens";
import { resolveSession } from "./session";
import { completeSignup, requestSignup, sealSignupToken, SIGNUP_RATE_LIMITS } from "./signup";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

const APP_URL = "http://app.test/";
const SECRET = "signup-test-secret-".padEnd(40, "x");
const ENABLED = { SIGNUP_ENABLED: "true" };
const clock = () => new Date();
const freshIp = () => `198.51.100.${randomUUID()}`;
const newEmail = () => `signup-${randomUUID()}@example.test`;

function request(email: string, mail = new MemoryEmailProvider(), env: Record<string, string> = ENABLED) {
  return requestSignup({ db: app.db, email, clock, emailProvider: mail, appUrl: APP_URL, ip: freshIp(), secret: SECRET, env });
}

function complete(token: string | null, overrides: { orgName?: string; userName?: string; env?: Record<string, string> } = {}) {
  return completeSignup({
    db: app.db,
    token,
    orgName: overrides.orgName ?? "Fernwood Design",
    userName: overrides.userName ?? "Ada Admin",
    clock,
    ip: freshIp(),
    secret: SECRET,
    env: overrides.env ?? ENABLED,
  });
}

function tokenFromMail(mail: MemoryEmailProvider, to: string): string {
  const text = mail.lastTo(to)?.text ?? "";
  const match = /http:\/\/app\.test\/signup\/complete\?token=(v1\.[A-Za-z0-9_-]+)/.exec(text);
  if (!match?.[1]) throw new Error("no sign-up link in the message");
  return match[1];
}

describe("requestSignup", () => {
  it("emails a sign-up link to a new address", async () => {
    const email = newEmail();
    const mail = new MemoryEmailProvider();
    expect(await request(`  ${email.toUpperCase()} `, mail)).toEqual({ status: "accepted" });
    const message = mail.lastTo(email);
    expect(message?.subject).toBe("Finish creating your Veradact account");
    expect(message?.tags).toEqual({ kind: "signup" });
    expect(tokenFromMail(mail, email)).toMatch(/^v1\./);
  });

  it("answers the same for an existing account but only sends a sign-in pointer", async () => {
    const { user } = await createTestTenant(admin.db);
    const mail = new MemoryEmailProvider();
    expect(await request(user.email, mail)).toEqual({ status: "accepted" });
    const message = mail.lastTo(user.email);
    expect(message?.tags).toEqual({ kind: "signup_existing" });
    expect(message?.text).toContain("http://app.test/login");
    expect(message?.text).not.toContain("/signup/complete");
  });

  it("does nothing when sign-up is disabled", async () => {
    const mail = new MemoryEmailProvider();
    expect(await request(newEmail(), mail, {})).toEqual({ status: "disabled" });
    expect(mail.messages).toEqual([]);
  });

  it("rejects malformed addresses", async () => {
    expect(await request("not-an-email")).toEqual({ status: "invalid_email" });
  });

  it("limits requests per email", async () => {
    const email = newEmail();
    for (let i = 0; i < SIGNUP_RATE_LIMITS.perEmail.limit; i++) {
      expect((await request(email)).status).toBe("accepted");
    }
    expect((await request(email)).status).toBe("rate_limited");
  });
});

describe("completeSignup", () => {
  it("creates the org with AI off, its admin and a working session, and audits both", async () => {
    const email = newEmail();
    const mail = new MemoryEmailProvider();
    await request(email, mail);
    const result = await complete(tokenFromMail(mail, email), { orgName: "  Fernwood Design ", userName: " Ada Admin " });
    if (result.status !== "ok") throw new Error(`signup failed: ${result.status}`);

    const [createdOrg] = await admin.db.select().from(org).where(eq(org.id, result.session.orgId));
    expect(createdOrg).toMatchObject({ name: "Fernwood Design", aiEnabled: false });
    expect(createdOrg?.slug).toMatch(/^fernwood-design-[0-9a-f]{6}$/);
    const [user] = await admin.db.select().from(appUser).where(eq(appUser.id, result.user.id));
    expect(user).toMatchObject({ email, name: "Ada Admin", role: "admin", orgId: result.session.orgId });
    expect(result.user).toEqual({ id: user!.id, email, name: "Ada Admin", role: "admin" });

    const [stored] = await admin.db.select().from(session).where(eq(session.id, result.session.sessionId));
    expect(stored?.tokenHash).toBe(hashToken(result.sessionToken));
    const resolved = await resolveSession({ db: app.db, token: result.sessionToken, clock });
    expect(resolved).toMatchObject({ orgId: result.session.orgId, userId: user!.id, role: "admin" });

    const audits = await admin.db
      .select({ action: auditLog.action, targetType: auditLog.targetType, metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.orgId, result.session.orgId));
    expect(audits).toEqual(
      expect.arrayContaining([
        { action: "auth.signup", targetType: "org", metadata: {} },
        { action: "auth.login", targetType: "session", metadata: { method: "signup" } },
      ]),
    );
  });

  it("reports an existing account and creates nothing when the link is used again", async () => {
    const email = newEmail();
    const token = sealSignupToken({ secret: SECRET, email, expiresAt: new Date(Date.now() + 60_000) });
    expect((await complete(token)).status).toBe("ok");
    expect(await complete(token, { orgName: "Second Org" })).toEqual({ status: "exists" });
    const users = await admin.db.select().from(appUser).where(eq(appUser.email, email));
    expect(users).toHaveLength(1);
    expect(await admin.db.select().from(org).where(and(eq(org.id, users[0]!.orgId), eq(org.name, "Second Org")))).toEqual([]);
  });

  it("rejects missing, forged and expired tokens", async () => {
    const email = newEmail();
    expect(await complete(null)).toEqual({ status: "invalid" });
    const forged = sealSignupToken({ secret: "another-secret-".padEnd(40, "y"), email, expiresAt: new Date(Date.now() + 60_000) });
    expect(await complete(forged)).toEqual({ status: "invalid" });
    const expired = sealSignupToken({ secret: SECRET, email, expiresAt: new Date(Date.now() - 1000) });
    expect(await complete(expired)).toEqual({ status: "invalid" });
    expect(await admin.db.select().from(appUser).where(eq(appUser.email, email))).toEqual([]);
  });

  it("validates the names before creating anything", async () => {
    const email = newEmail();
    const token = sealSignupToken({ secret: SECRET, email, expiresAt: new Date(Date.now() + 60_000) });
    await expect(complete(token, { orgName: "   " })).rejects.toBeInstanceOf(ValidationError);
    await expect(complete(token, { userName: "x".repeat(201) })).rejects.toBeInstanceOf(ValidationError);
    expect(await admin.db.select().from(appUser).where(eq(appUser.email, email))).toEqual([]);
  });

  it("does nothing when sign-up is disabled", async () => {
    const email = newEmail();
    const token = sealSignupToken({ secret: SECRET, email, expiresAt: new Date(Date.now() + 60_000) });
    expect(await complete(token, { env: {} })).toEqual({ status: "disabled" });
    expect(await admin.db.select().from(appUser).where(eq(appUser.email, email))).toEqual([]);
  });
});
