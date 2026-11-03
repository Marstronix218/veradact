// Demo password sign-in against real Postgres as the app role.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { auditLog } from "@veradact/db";
import { adminTestDb, createTestTenant, createTestUser, testDb } from "@veradact/db/testing";
import { DEMO_LOGIN_RATE_LIMITS, loginWithDemoPassword } from "./demo-login";
import { resolveSession } from "./session";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

const PASSWORD = "quillfield-demo";
const clock = () => new Date();
const freshIp = () => `198.51.100.${randomUUID()}`;

// Each test org stands in for the demo org through DEMO_LOGIN_ORG_SLUG (org slugs are unique).
async function demoUser() {
  const { org } = await createTestTenant(admin.db);
  const user = await createTestUser(admin.db, { orgId: org.id, email: `admin-${randomUUID()}@quillfield.example` });
  return { org, user, env: { DEMO_LOGIN_PASSWORD: PASSWORD, DEMO_LOGIN_ORG_SLUG: org.slug } };
}

function attempt(email: string, env: Record<string, string | undefined>, options: { password?: string; ip?: string } = {}) {
  return loginWithDemoPassword({ db: app.db, email, password: options.password ?? PASSWORD, clock, ip: options.ip ?? freshIp(), env });
}

describe("loginWithDemoPassword", () => {
  it("opens a session for a demo user and audits the method", async () => {
    const { org, user, env } = await demoUser();
    const result = await attempt(` ${user.email.toUpperCase()} `, env);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.user).toMatchObject({ id: user.id, email: user.email });

    const resolved = await resolveSession({ db: app.db, token: result.sessionToken, clock });
    expect(resolved).toMatchObject({ orgId: org.id, userId: user.id, sessionId: result.session.sessionId });

    const audits = await admin.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, org.id), eq(auditLog.action, "auth.login")));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorUserId: user.id, targetId: result.session.sessionId, metadata: { method: "demo_password" } });
  });

  it("is disabled without a configured password", async () => {
    const { user, env } = await demoUser();
    expect(await attempt(user.email, { ...env, DEMO_LOGIN_PASSWORD: undefined })).toEqual({ status: "disabled" });
    expect(await attempt(user.email, { ...env, DEMO_LOGIN_PASSWORD: "short" }, { password: "short" })).toEqual({ status: "disabled" });
    expect(await attempt(user.email, { ...env, NODE_ENV: "production" })).toEqual({ status: "disabled" });
  });

  it("rejects a wrong password, a non-demo address, an unknown and a deactivated user alike", async () => {
    const { org, user, env } = await demoUser();
    const real = await createTestUser(admin.db, { orgId: org.id }); // user-…@example.test, same org
    const gone = await createTestUser(admin.db, { orgId: org.id, email: `gone-${randomUUID()}@quillfield.example`, deactivatedAt: new Date() });

    expect(await attempt(user.email, env, { password: `${PASSWORD}x` })).toEqual({ status: "invalid" });
    expect(await attempt(user.email, env, { password: "" })).toEqual({ status: "invalid" });
    expect(await attempt(real.email, env)).toEqual({ status: "invalid" });
    expect(await attempt(`nobody-${randomUUID()}@quillfield.example`, env)).toEqual({ status: "invalid" });
    expect(await attempt(gone.email, env)).toEqual({ status: "invalid" });
    expect(await attempt("not an email", env)).toEqual({ status: "invalid" });
  });

  it("rejects a .example user of any org other than the demo org", async () => {
    const { env } = await demoUser();
    // E.g. a placeholder address a customer admin invited into their own org.
    const other = await demoUser();
    expect(await attempt(other.user.email, env)).toEqual({ status: "invalid" });
  });

  it("limits attempts per IP", async () => {
    const { user, env } = await demoUser();
    const ip = freshIp();
    for (let i = 0; i < DEMO_LOGIN_RATE_LIMITS.perIp.limit; i += 1) {
      expect((await attempt(user.email, env, { password: "wrong-password", ip })).status).toBe("invalid");
    }
    const limited = await attempt(user.email, env, { ip });
    expect(limited.status).toBe("rate_limited");
  });
});
