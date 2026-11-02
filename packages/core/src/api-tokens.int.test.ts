// API tokens against real Postgres as the app role.
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { apiToken, auditLog } from "@veradact/db";
import { adminTestDb, createTestTenant, createTestUser, testDb, type TestTenant } from "@veradact/db/testing";
import { createApiToken, listApiTokens, resolveApiToken, revokeApiToken } from "./api-tokens";
import type { AuthContext } from "./auth/context";
import { NotFoundError, ValidationError } from "./errors";
import { hashToken } from "./security/tokens";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

const clock = () => new Date();
const adminCtx = (t: TestTenant): AuthContext => ({ orgId: t.org.id, userId: t.user.id, role: "admin" });

async function memberOf(t: TestTenant): Promise<AuthContext & { email: string }> {
  const member = await createTestUser(admin.db, { orgId: t.org.id, role: "member" });
  return { orgId: t.org.id, userId: member.id, role: "member", email: member.email };
}

const auditsOf = (orgId: string, action: string) =>
  admin.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, action)));

describe("api tokens", () => {
  it("returns the raw token once, stores prefix + hash, and audits api_token.create", async () => {
    const t = await createTestTenant(admin.db);
    const created = await createApiToken({ db: app.db, ctx: adminCtx(t), clock, name: " Claude Code " });
    expect(created.name).toBe("Claude Code");
    expect(created.token).toMatch(/^vdt_[A-Za-z0-9_-]{43}$/);
    expect(created.tokenPrefix).toBe(created.token.slice(0, 12));

    const [row] = await admin.db.select().from(apiToken).where(eq(apiToken.id, created.id));
    expect(row).toMatchObject({
      orgId: t.org.id,
      userId: t.user.id,
      tokenPrefix: created.tokenPrefix,
      tokenHash: hashToken(created.token),
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(JSON.stringify(row)).not.toContain(created.token);

    const audits = await auditsOf(t.org.id, "api_token.create");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorUserId: t.user.id, targetType: "api_token", targetId: created.id });
  });

  it("rejects blank and overlong names", async () => {
    const t = await createTestTenant(admin.db);
    for (const name of ["", "   ", "x".repeat(101)]) {
      await expect(createApiToken({ db: app.db, ctx: adminCtx(t), clock, name })).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("resolves to org, user and role and updates last_used_at at most once a minute", async () => {
    const t = await createTestTenant(admin.db);
    const member = await memberOf(t);
    const created = await createApiToken({ db: app.db, ctx: member, clock, name: "cursor" });

    const t0 = new Date();
    expect(await resolveApiToken(app.db, created.token, () => t0)).toEqual({
      apiTokenId: created.id,
      orgId: t.org.id,
      userId: member.userId,
      role: "member",
    });
    const lastUsed = async () =>
      (await admin.db.select().from(apiToken).where(eq(apiToken.id, created.id)))[0]?.lastUsedAt?.getTime();
    expect(await lastUsed()).toBe(t0.getTime());
    await resolveApiToken(app.db, created.token, () => new Date(t0.getTime() + 30_000));
    expect(await lastUsed()).toBe(t0.getTime());
    const t2 = new Date(t0.getTime() + 61_000);
    await resolveApiToken(app.db, created.token, () => t2);
    expect(await lastUsed()).toBe(t2.getTime());
  });

  it("does not resolve malformed or unknown tokens", async () => {
    for (const raw of [undefined, null, "", "vdt_", "vdt_short", `vdt_${"a".repeat(43)}`, `xyz_${"a".repeat(43)}`]) {
      expect(await resolveApiToken(app.db, raw, clock)).toBeNull();
    }
  });

  it("members list their own tokens; admins list every token in the org", async () => {
    const t = await createTestTenant(admin.db);
    const member = await memberOf(t);
    const mine = await createApiToken({ db: app.db, ctx: member, clock, name: "member token" });
    const adminToken = await createApiToken({ db: app.db, ctx: adminCtx(t), clock, name: "admin token" });

    const memberList = await listApiTokens(app.db, member);
    expect(memberList.map((x) => x.id)).toEqual([mine.id]);
    expect(memberList[0]).toMatchObject({ name: "member token", tokenPrefix: mine.tokenPrefix, userEmail: member.email });
    expect(JSON.stringify(memberList)).not.toContain(mine.token);

    const adminList = await listApiTokens(app.db, adminCtx(t));
    expect(new Set(adminList.map((x) => x.id))).toEqual(new Set([mine.id, adminToken.id]));
  });

  it("revoking stops resolution and audits api_token.revoke; repeat revokes are no-ops", async () => {
    const t = await createTestTenant(admin.db);
    const created = await createApiToken({ db: app.db, ctx: adminCtx(t), clock, name: "ci" });
    await revokeApiToken({ db: app.db, ctx: adminCtx(t), clock, tokenId: created.id });
    expect(await resolveApiToken(app.db, created.token, clock)).toBeNull();
    await revokeApiToken({ db: app.db, ctx: adminCtx(t), clock, tokenId: created.id });

    const audits = await auditsOf(t.org.id, "api_token.revoke");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorUserId: t.user.id, targetType: "api_token", targetId: created.id });
    const [listed] = await listApiTokens(app.db, adminCtx(t));
    expect(listed?.revokedAt).toBeInstanceOf(Date);
  });

  it("members cannot revoke other users' tokens; admins can", async () => {
    const t = await createTestTenant(admin.db);
    const member = await memberOf(t);
    const adminToken = await createApiToken({ db: app.db, ctx: adminCtx(t), clock, name: "admin" });
    const memberToken = await createApiToken({ db: app.db, ctx: member, clock, name: "member" });

    await expect(
      revokeApiToken({ db: app.db, ctx: member, clock, tokenId: adminToken.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await resolveApiToken(app.db, adminToken.token, clock)).not.toBeNull();

    await revokeApiToken({ db: app.db, ctx: adminCtx(t), clock, tokenId: memberToken.id });
    expect(await resolveApiToken(app.db, memberToken.token, clock)).toBeNull();
  });

  it("an org A admin cannot see or revoke org B tokens", async () => {
    const a = await createTestTenant(admin.db);
    const b = await createTestTenant(admin.db);
    const bToken = await createApiToken({ db: app.db, ctx: adminCtx(b), clock, name: "b" });

    expect(await listApiTokens(app.db, adminCtx(a))).toEqual([]);
    await expect(
      revokeApiToken({ db: app.db, ctx: adminCtx(a), clock, tokenId: bToken.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      revokeApiToken({ db: app.db, ctx: adminCtx(a), clock, tokenId: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await resolveApiToken(app.db, bToken.token, clock)).not.toBeNull();
  });
});
