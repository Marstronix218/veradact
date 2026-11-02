// Org settings and user management against real Postgres as the app role.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { apiToken, appUser, auditLog, authFindUserByEmail, DEFAULT_ALL_PARTY_STATES, org, session } from "@veradact/db";
import { adminTestDb, createTestTenant, createTestUser, testDb, type TestTenant } from "@veradact/db/testing";
import { MemoryEmailProvider } from "@veradact/email";
import { createApiToken, resolveApiToken } from "../api-tokens";
import type { AuthContext } from "../auth/context";
import { createSession, resolveSession } from "../auth/session";
import { requestMagicLink } from "../auth/magic-link";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitedError, ValidationError } from "../errors";
import { getOrgSettings, updateOrgSettings } from "./settings";
import { deactivatedEmail, deactivateUser, getCurrentUser, INVITE_CONFLICT_MESSAGE, INVITE_RATE_LIMIT, inviteUser, listUsers } from "./users";
import { withTenant } from "@veradact/db";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

const APP_URL = "http://app.test";
const clock = () => new Date();

const adminCtx = (t: TestTenant): AuthContext => ({ orgId: t.org.id, userId: t.user.id, role: "admin" });

async function memberOf(t: TestTenant): Promise<AuthContext> {
  const member = await createTestUser(admin.db, { orgId: t.org.id, role: "member" });
  return { orgId: t.org.id, userId: member.id, role: "member" };
}

async function auditsOf(orgId: string, action: string) {
  return admin.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, action)));
}

async function sessionFor(orgId: string, userId: string) {
  return withTenant(app.db, { orgId, userId }, (tx) => createSession(tx, { orgId, userId, now: new Date() }));
}

describe("org settings", () => {
  it("reads the defaults", async () => {
    const t = await createTestTenant(admin.db);
    expect(await getOrgSettings(app.db, await memberOf(t))).toEqual({
      orgId: t.org.id,
      name: t.org.name,
      slug: t.org.slug,
      aiEnabled: true,
      retentionDays: null,
      allPartyStates: [...DEFAULT_ALL_PARTY_STATES],
      blockUnknownJurisdictions: true,
      reminderBusinessDays: 2,
    });
  });

  it("toggling AI audits ai.toggle with before/after", async () => {
    const t = await createTestTenant(admin.db);
    const updated = await updateOrgSettings({ db: app.db, ctx: adminCtx(t), clock, patch: { aiEnabled: false } });
    expect(updated.aiEnabled).toBe(false);
    expect((await getOrgSettings(app.db, adminCtx(t))).aiEnabled).toBe(false);

    const audits = await auditsOf(t.org.id, "ai.toggle");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: t.user.id,
      targetType: "org",
      targetId: t.org.id,
      metadata: { scope: "org", before: true, after: false },
    });
    expect(await auditsOf(t.org.id, "settings.update")).toHaveLength(0);
  });

  it("other changes audit settings.update with before/after values and counts", async () => {
    const t = await createTestTenant(admin.db);
    const updated = await updateOrgSettings({
      db: app.db,
      ctx: adminCtx(t),
      clock,
      patch: {
        retentionDays: 90,
        allPartyStates: [" wa", "CA", "ca", "dc"],
        blockUnknownJurisdictions: false,
        reminderBusinessDays: 3,
      },
    });
    expect(updated).toMatchObject({
      retentionDays: 90,
      allPartyStates: ["CA", "DC", "WA"],
      blockUnknownJurisdictions: false,
      reminderBusinessDays: 3,
    });
    const [row] = await admin.db.select().from(org).where(eq(org.id, t.org.id));
    expect(row).toMatchObject({ retentionDays: 90, allPartyStates: ["CA", "DC", "WA"], reminderBusinessDays: 3 });

    const audits = await auditsOf(t.org.id, "settings.update");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toEqual({
      retention_days_before: null,
      retention_days_after: 90,
      all_party_states_count_before: DEFAULT_ALL_PARTY_STATES.length,
      all_party_states_count_after: 3,
      block_unknown_jurisdictions_before: true,
      block_unknown_jurisdictions_after: false,
      reminder_business_days_before: 2,
      reminder_business_days_after: 3,
    });
    expect(await auditsOf(t.org.id, "ai.toggle")).toHaveLength(0);
  });

  it("a patch that changes nothing writes no audit row", async () => {
    const t = await createTestTenant(admin.db);
    await updateOrgSettings({
      db: app.db,
      ctx: adminCtx(t),
      clock,
      patch: { aiEnabled: true, reminderBusinessDays: 2, allPartyStates: [...DEFAULT_ALL_PARTY_STATES].reverse() },
    });
    const rows = await admin.db.select().from(auditLog).where(eq(auditLog.orgId, t.org.id));
    expect(rows).toHaveLength(0);
  });

  it("validates input", async () => {
    const t = await createTestTenant(admin.db);
    const update = (patch: Parameters<typeof updateOrgSettings>[0]["patch"]) =>
      updateOrgSettings({ db: app.db, ctx: adminCtx(t), clock, patch });
    await expect(update({ allPartyStates: ["ZZ"] })).rejects.toBeInstanceOf(ValidationError);
    await expect(update({ allPartyStates: ["California"] })).rejects.toBeInstanceOf(ValidationError);
    await expect(update({ retentionDays: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(update({ retentionDays: 1.5 })).rejects.toBeInstanceOf(ValidationError);
    await expect(update({ reminderBusinessDays: 11 })).rejects.toBeInstanceOf(ValidationError);
    expect((await update({ retentionDays: null })).retentionDays).toBeNull();
  });

  it("members can read but not change settings", async () => {
    const t = await createTestTenant(admin.db);
    const member = await memberOf(t);
    await expect(
      updateOrgSettings({ db: app.db, ctx: member, clock, patch: { aiEnabled: false } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      updateOrgSettings({ db: app.db, ctx: member, clock, patch: { retentionDays: 30 } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await getOrgSettings(app.db, member)).toMatchObject({ aiEnabled: true, retentionDays: null });
    expect(await admin.db.select().from(auditLog).where(eq(auditLog.orgId, t.org.id))).toHaveLength(0);
  });
});

describe("users", () => {
  it("invites a user, emails the login URL and audits user.invite", async () => {
    const t = await createTestTenant(admin.db);
    const mail = new MemoryEmailProvider();
    const email = `New.Person-${randomUUID()}@Example.test`;
    const { user, emailSent } = await inviteUser({
      db: app.db,
      ctx: adminCtx(t),
      clock,
      emailProvider: mail,
      appUrl: APP_URL,
      email,
      name: "  Nova Member ",
      role: "member",
    });
    expect(emailSent).toBe(true);
    expect(user).toMatchObject({ email: email.toLowerCase(), name: "Nova Member", role: "member", deactivatedAt: null });

    const message = mail.lastTo(email.toLowerCase());
    expect(message?.text).toContain(`${APP_URL}/login`);
    expect(message?.tags).toEqual({ kind: "user_invite" });

    const audits = await auditsOf(t.org.id, "user.invite");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorUserId: t.user.id, targetType: "user", targetId: user.id, metadata: { role: "member" } });

    // The invitee can sign in with a magic link.
    const loginMail = new MemoryEmailProvider();
    await requestMagicLink({ db: app.db, email, clock, emailProvider: loginMail, appUrl: APP_URL, ip: randomUUID() });
    expect(loginMail.lastTo(email.toLowerCase())).toBeDefined();
  });

  it("rejects duplicate emails, bad input and members", async () => {
    const t = await createTestTenant(admin.db);
    const other = await createTestTenant(admin.db);
    const base = {
      db: app.db,
      ctx: adminCtx(t),
      clock,
      emailProvider: new MemoryEmailProvider(),
      appUrl: APP_URL,
      name: "Someone",
      role: "member" as const,
    };
    await expect(inviteUser({ ...base, email: t.user.email })).rejects.toBeInstanceOf(ConflictError);
    // Emails are unique across orgs (one org per user in the MVP); the message is the same as for
    // an address of this org, so an admin learns nothing about other tenants' users.
    const own = (await inviteUser({ ...base, email: t.user.email }).catch((error: unknown) => error)) as Error;
    const foreign = (await inviteUser({ ...base, email: other.user.email.toUpperCase() }).catch((error: unknown) => error)) as Error;
    expect(foreign).toBeInstanceOf(ConflictError);
    expect(foreign.message).toBe(INVITE_CONFLICT_MESSAGE);
    expect(own.message).toBe(INVITE_CONFLICT_MESSAGE);
    expect(foreign.message).not.toMatch(/Veradact user|already/i);
    await expect(inviteUser({ ...base, email: "not-an-email" })).rejects.toBeInstanceOf(ValidationError);
    await expect(inviteUser({ ...base, email: `x-${randomUUID()}@example.test`, name: " " })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      inviteUser({ ...base, email: `x-${randomUUID()}@example.test`, role: "owner" as never }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      inviteUser({ ...base, ctx: await memberOf(t), email: `x-${randomUUID()}@example.test` }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await auditsOf(t.org.id, "user.invite")).toHaveLength(0);
  });

  it("limits invitation attempts to 20 per hour per org, conflicts included, without affecting other orgs", async () => {
    expect(INVITE_RATE_LIMIT).toEqual({ limit: 20, windowSeconds: 3600 });
    const t = await createTestTenant(admin.db);
    const other = await createTestTenant(admin.db);
    const mail = new MemoryEmailProvider();
    // A fixed instant 10 minutes into an hour-long window.
    const at = (iso: string) => () => new Date(iso);
    const invite = (tenant: TestTenant, email: string, clock = at("2026-06-01T12:10:00.000Z")) =>
      inviteUser({ db: app.db, ctx: adminCtx(tenant), clock, emailProvider: mail, appUrl: APP_URL, email, name: "Someone", role: "member" });

    // Probing an address that belongs to another org counts like any other attempt.
    await expect(invite(t, other.user.email)).rejects.toBeInstanceOf(ConflictError);
    for (let i = 1; i < INVITE_RATE_LIMIT.limit; i++) await invite(t, `bulk-${i}-${randomUUID()}@example.test`);
    const limited = (await invite(t, `one-more-${randomUUID()}@example.test`).catch((error: unknown) => error)) as RateLimitedError;
    expect(limited).toBeInstanceOf(RateLimitedError);
    expect(limited.retryAfterSeconds).toBe(50 * 60);
    // The same answer for a probe of a foreign address: nothing to learn once limited.
    expect(await invite(t, other.user.email).catch((error: unknown) => error)).toBeInstanceOf(RateLimitedError);
    expect(await auditsOf(t.org.id, "user.invite")).toHaveLength(INVITE_RATE_LIMIT.limit - 1);

    // Other orgs have their own window, and the next hour starts a new one.
    await expect(invite(other, `x-${randomUUID()}@example.test`)).resolves.toMatchObject({ emailSent: true });
    await expect(invite(t, `next-hour-${randomUUID()}@example.test`, at("2026-06-01T13:00:00.000Z"))).resolves.toMatchObject({ emailSent: true });
  });

  it("deactivation anonymizes the user, revokes sessions and API tokens, and audits", async () => {
    const t = await createTestTenant(admin.db);
    const target = await createTestUser(admin.db, { orgId: t.org.id, role: "member" });
    const targetCtx: AuthContext = { orgId: t.org.id, userId: target.id, role: "member" };
    const s = await sessionFor(t.org.id, target.id);
    const token = await createApiToken({ db: app.db, ctx: targetCtx, clock, name: "laptop" });
    expect(await resolveSession({ db: app.db, token: s.token, clock })).not.toBeNull();

    const result = await deactivateUser({ db: app.db, ctx: adminCtx(t), clock, userId: target.id });
    expect(result).toMatchObject({ id: target.id, email: deactivatedEmail(target.id), name: "Deactivated user" });
    expect(result.deactivatedAt).toBeInstanceOf(Date);

    expect(await resolveSession({ db: app.db, token: s.token, clock })).toBeNull();
    expect(await resolveApiToken(app.db, token.token, clock)).toBeNull();
    expect(await authFindUserByEmail(app.db, target.email)).toBeNull();
    const [sessionRow] = await admin.db.select().from(session).where(eq(session.id, s.sessionId));
    expect(sessionRow?.revokedAt).toBeInstanceOf(Date);
    const [tokenRow] = await admin.db.select().from(apiToken).where(eq(apiToken.id, token.id));
    expect(tokenRow?.revokedAt).toBeInstanceOf(Date);

    const audits = await auditsOf(t.org.id, "user.deactivate");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: t.user.id,
      targetType: "user",
      targetId: target.id,
      metadata: { sessions_revoked: 1, api_tokens_revoked: 1 },
    });

    // Idempotent, and the old address can be reused for a new invite.
    await deactivateUser({ db: app.db, ctx: adminCtx(t), clock, userId: target.id });
    expect(await auditsOf(t.org.id, "user.deactivate")).toHaveLength(1);
    const reinvited = await inviteUser({
      db: app.db,
      ctx: adminCtx(t),
      clock,
      emailProvider: new MemoryEmailProvider(),
      appUrl: APP_URL,
      email: target.email,
      name: "Back Again",
      role: "member",
    });
    expect(reinvited.user.id).not.toBe(target.id);
  });

  it("an admin cannot deactivate themselves; members cannot deactivate anyone", async () => {
    const t = await createTestTenant(admin.db);
    await expect(deactivateUser({ db: app.db, ctx: adminCtx(t), clock, userId: t.user.id })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const member = await memberOf(t);
    await expect(deactivateUser({ db: app.db, ctx: member, clock, userId: t.user.id })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const [row] = await admin.db.select().from(appUser).where(eq(appUser.id, t.user.id));
    expect(row?.deactivatedAt).toBeNull();
  });

  it("lists the org's users, active first", async () => {
    const t = await createTestTenant(admin.db);
    const gone = await createTestUser(admin.db, {
      orgId: t.org.id,
      role: "member",
      createdAt: new Date(Date.now() - 60_000),
      deactivatedAt: new Date(),
    });
    const member = await createTestUser(admin.db, { orgId: t.org.id, role: "member", createdAt: new Date(Date.now() + 1000) });
    const users = await listUsers(app.db, adminCtx(t));
    expect(users.map((u) => u.id)).toEqual([t.user.id, member.id, gone.id]);
    expect((await getCurrentUser(app.db, adminCtx(t))).email).toBe(t.user.email);
  });
});

describe("cross-tenant isolation", () => {
  it("an org A admin cannot list or deactivate org B users", async () => {
    const a = await createTestTenant(admin.db);
    const b = await createTestTenant(admin.db);
    const bMember = await createTestUser(admin.db, { orgId: b.org.id, role: "member" });

    const listed = await listUsers(app.db, adminCtx(a));
    expect(listed.map((u) => u.id)).toEqual([a.user.id]);

    for (const userId of [b.user.id, bMember.id]) {
      await expect(deactivateUser({ db: app.db, ctx: adminCtx(a), clock, userId })).rejects.toBeInstanceOf(NotFoundError);
    }
    const rows = await admin.db.select().from(appUser).where(eq(appUser.orgId, b.org.id));
    expect(rows.every((u) => u.deactivatedAt === null)).toBe(true);
    expect(await admin.db.select().from(auditLog).where(eq(auditLog.orgId, a.org.id))).toHaveLength(0);
  });

  it("a forged context cannot read another org's settings", async () => {
    const a = await createTestTenant(admin.db);
    const b = await createTestTenant(admin.db);
    // RLS keys on the org in the context; the org row of B is invisible under A.
    const settings = await getOrgSettings(app.db, adminCtx(a));
    expect(settings.orgId).toBe(a.org.id);
    await expect(
      updateOrgSettings({ db: app.db, ctx: { ...adminCtx(a), orgId: randomUUID() }, clock, patch: { aiEnabled: false } }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const [bRow] = await admin.db.select().from(org).where(eq(org.id, b.org.id));
    expect(bRow?.aiEnabled).toBe(true);
  });
});
