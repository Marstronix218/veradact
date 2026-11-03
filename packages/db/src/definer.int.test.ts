// Pre-tenant SECURITY DEFINER functions (ARCHITECTURE §7), called as the app role.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  authConsumeLoginToken,
  authFindUserByEmail,
  authResolveApiToken,
  authResolveSession,
  jobsListOrgIds,
  linkResolve,
  signupCreateOrg,
} from "./definer";
import { apiToken, appUser, confirmationLink, loginToken, org, session } from "./schema";
import {
  adminTestDb,
  createTestContact,
  createTestTenant,
  createTestUser,
  randomHash,
  testDb,
} from "./testing";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

const minutes = (n: number) => new Date(Date.now() + n * 60_000);

/** Function -> exact output columns. Anything more would leak to a pre-tenant caller. */
const FUNCTIONS: Record<string, { signature: string; columns: string[] }> = {
  auth_find_user_by_email: { signature: "auth_find_user_by_email(text)", columns: ["user_id", "org_id"] },
  auth_consume_login_token: {
    signature: "auth_consume_login_token(text)",
    columns: ["login_token_id", "user_id", "org_id"],
  },
  auth_resolve_session: {
    signature: "auth_resolve_session(text)",
    columns: ["session_id", "user_id", "org_id", "role", "expires_at"],
  },
  auth_resolve_api_token: {
    signature: "auth_resolve_api_token(text)",
    columns: ["api_token_id", "user_id", "org_id", "role"],
  },
  link_resolve: {
    signature: "link_resolve(uuid)",
    columns: ["link_id", "org_id", "engagement_id", "request_id", "contact_id", "expires_at", "revoked_at"],
  },
  jobs_list_org_ids: { signature: "jobs_list_org_ids()", columns: [] },
  signup_create_org: {
    signature: "signup_create_org(uuid, text, text, uuid, text, text, timestamptz)",
    columns: ["org_id", "user_id"],
  },
};

describe("definer function catalog", () => {
  it.each(Object.entries(FUNCTIONS))("%s is a locked-down SECURITY DEFINER function", async (_name, fn) => {
    const [row] = await admin.db.execute<{
      definer: boolean;
      config: string[] | null;
      public_execute: boolean;
      app_execute: boolean;
      owner_is_table_owner: boolean;
      out_columns: string[] | null;
    }>(sql`
      select p.prosecdef as definer,
             p.proconfig as config,
             exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                      where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as public_execute,
             has_function_privilege('veradact_app', p.oid, 'EXECUTE') as app_execute,
             p.proowner = (select relowner from pg_class where oid = 'public.event'::regclass) as owner_is_table_owner,
             (select array_agg(n order by i)
                from unnest(p.proargnames, p.proargmodes) with ordinality as a(n, m, i)
               where a.m in ('o', 't')) as out_columns
        from pg_proc p
       where p.oid = ${fn.signature}::regprocedure`);
    expect(row).toEqual({
      definer: true,
      config: ["search_path=public, pg_temp"],
      public_execute: false,
      app_execute: true,
      owner_is_table_owner: true,
      out_columns: fn.columns.length > 0 ? fn.columns : null,
    });
  });

  it("the chain trigger function is SECURITY DEFINER with a pinned search_path", async () => {
    const [row] = await admin.db.execute<{ definer: boolean; config: string[] | null }>(sql`
      select prosecdef as definer, proconfig as config
        from pg_proc where oid = 'event_check_chain()'::regprocedure`);
    expect(row).toEqual({ definer: true, config: ["search_path=public, pg_temp"] });
  });
});

describe("auth_find_user_by_email", () => {
  it("finds an active user case-insensitively and returns only ids", async () => {
    const { org, user } = await createTestTenant(admin.db);
    const rows = await app.db.execute(
      sql`select * from auth_find_user_by_email(${user.email.toUpperCase()})`,
    );
    expect(rows).toEqual([{ user_id: user.id, org_id: org.id }]);
    expect(await authFindUserByEmail(app.db, user.email)).toEqual({ userId: user.id, orgId: org.id });
  });

  it("ignores deactivated users and unknown emails", async () => {
    const { org } = await createTestTenant(admin.db);
    const gone = await createTestUser(admin.db, { orgId: org.id, deactivatedAt: new Date() });
    expect(await authFindUserByEmail(app.db, gone.email)).toBeNull();
    expect(await authFindUserByEmail(app.db, `nobody-${randomUUID()}@example.test`)).toBeNull();
  });
});

describe("auth_consume_login_token", () => {
  async function tokenFor(overrides: Partial<typeof loginToken.$inferInsert> = {}, deactivated = false) {
    const { org } = await createTestTenant(admin.db);
    const user = await createTestUser(admin.db, {
      orgId: org.id,
      deactivatedAt: deactivated ? new Date() : null,
    });
    const hash = randomHash();
    const [row] = await admin.db
      .insert(loginToken)
      .values({
        orgId: org.id,
        userId: user.id,
        tokenHash: hash,
        expiresAt: minutes(15),
        createdAt: new Date(),
        ...overrides,
      })
      .returning();
    return { org, user, hash, token: row! };
  }

  it("is single use", async () => {
    const { org, user, hash, token } = await tokenFor();
    expect(await authConsumeLoginToken(app.db, hash)).toEqual({
      loginTokenId: token.id,
      userId: user.id,
      orgId: org.id,
    });
    expect(await authConsumeLoginToken(app.db, hash)).toBeNull();
  });

  it("succeeds exactly once under concurrent use", async () => {
    const { hash } = await tokenFor();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => authConsumeLoginToken(app.db, hash)),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("rejects expired tokens, already-used tokens and deactivated users", async () => {
    const expired = await tokenFor({ expiresAt: minutes(-1) });
    const used = await tokenFor({ usedAt: new Date() });
    const deactivated = await tokenFor({}, true);
    for (const { hash } of [expired, used, deactivated]) {
      expect(await authConsumeLoginToken(app.db, hash)).toBeNull();
    }
    expect(await authConsumeLoginToken(app.db, randomHash())).toBeNull();
  });
});

describe("auth_resolve_session", () => {
  async function sessionFor(overrides: Partial<typeof session.$inferInsert> = {}) {
    const { org, user } = await createTestTenant(admin.db);
    const hash = randomHash();
    const [row] = await admin.db
      .insert(session)
      .values({ orgId: org.id, userId: user.id, tokenHash: hash, expiresAt: minutes(60), createdAt: new Date(), ...overrides })
      .returning();
    return { org, user, hash, session: row! };
  }

  it("resolves a live session to user, org, role and expiry only", async () => {
    const { org, user, hash, session: s } = await sessionFor();
    expect(await authResolveSession(app.db, hash)).toEqual({
      sessionId: s.id,
      userId: user.id,
      orgId: org.id,
      role: "admin",
      expiresAt: s.expiresAt,
    });
  });

  it("does not resolve revoked or expired sessions, or deactivated users", async () => {
    const revoked = await sessionFor({ revokedAt: new Date() });
    const expired = await sessionFor({ expiresAt: minutes(-1) });
    const deactivated = await sessionFor();
    await admin.db
      .update(appUser)
      .set({ deactivatedAt: new Date() })
      .where(sql`${appUser.id} = ${deactivated.user.id}`);
    for (const { hash } of [revoked, expired, deactivated]) {
      expect(await authResolveSession(app.db, hash)).toBeNull();
    }
  });
});

describe("auth_resolve_api_token", () => {
  async function tokenFor(overrides: Partial<typeof apiToken.$inferInsert> = {}) {
    const { org, user } = await createTestTenant(admin.db);
    const hash = randomHash();
    const [row] = await admin.db
      .insert(apiToken)
      .values({
        orgId: org.id,
        userId: user.id,
        name: "agent",
        tokenPrefix: "vdt_test",
        tokenHash: hash,
        createdAt: new Date(),
        ...overrides,
      })
      .returning();
    return { org, user, hash, token: row! };
  }

  it("resolves a live token to token id, user, org and role", async () => {
    const { org, user, hash, token } = await tokenFor();
    expect(await authResolveApiToken(app.db, hash)).toEqual({
      apiTokenId: token.id,
      userId: user.id,
      orgId: org.id,
      role: "admin",
    });
  });

  it("does not resolve revoked tokens or deactivated users", async () => {
    const revoked = await tokenFor({ revokedAt: new Date() });
    const deactivated = await tokenFor();
    await admin.db
      .update(appUser)
      .set({ deactivatedAt: new Date() })
      .where(sql`${appUser.id} = ${deactivated.user.id}`);
    for (const { hash } of [revoked, deactivated]) {
      expect(await authResolveApiToken(app.db, hash)).toBeNull();
    }
  });
});

describe("link_resolve", () => {
  it("returns the link's tenant and binding, including expired and revoked links", async () => {
    const { org, engagement } = await createTestTenant(admin.db);
    const contact = await createTestContact(admin.db, { orgId: org.id, engagementId: engagement.id });
    const requestId = randomUUID();
    const expiresAt = minutes(-5);
    const revokedAt = new Date();
    const [link] = await admin.db
      .insert(confirmationLink)
      .values({
        orgId: org.id,
        engagementId: engagement.id,
        requestId,
        contactId: contact.id,
        sentToEmail: "pat@example.test",
        expiresAt,
        revokedAt,
        createdAt: new Date(),
      })
      .returning();
    expect(await linkResolve(app.db, link!.id)).toEqual({
      linkId: link!.id,
      orgId: org.id,
      engagementId: engagement.id,
      requestId,
      contactId: contact.id,
      expiresAt,
      revokedAt,
    });
  });

  it("returns null for unknown and malformed ids", async () => {
    expect(await linkResolve(app.db, randomUUID())).toBeNull();
    expect(await linkResolve(app.db, "not-a-uuid")).toBeNull();
  });
});

describe("jobs_list_org_ids", () => {
  it("lists every org id", async () => {
    const [one, two] = await Promise.all([createTestTenant(admin.db), createTestTenant(admin.db)]);
    const ids = await jobsListOrgIds(app.db);
    expect(ids).toEqual(expect.arrayContaining([one.org.id, two.org.id]));
  });
});

describe("signup_create_org", () => {
  const input = () => ({
    orgId: randomUUID(),
    orgName: "Signup Org",
    slug: `signup-${randomUUID()}`,
    userId: randomUUID(),
    email: `signup-${randomUUID()}@example.test`,
    userName: "Signup Admin",
    createdAt: new Date(),
  });

  it("creates the org with AI off and its first user as admin", async () => {
    const values = input();
    expect(await signupCreateOrg(app.db, values)).toEqual({ orgId: values.orgId, userId: values.userId });
    const [created] = await admin.db.select().from(org).where(eq(org.id, values.orgId));
    expect(created).toMatchObject({ name: "Signup Org", slug: values.slug, aiEnabled: false });
    const [user] = await admin.db.select().from(appUser).where(eq(appUser.id, values.userId));
    expect(user).toMatchObject({ orgId: values.orgId, email: values.email, name: "Signup Admin", role: "admin" });
  });

  it("returns null and creates nothing when the email already has a user", async () => {
    const { user } = await createTestTenant(admin.db);
    const values = { ...input(), email: user.email.toUpperCase() };
    expect(await signupCreateOrg(app.db, values)).toBeNull();
    expect(await admin.db.select().from(org).where(eq(org.id, values.orgId))).toEqual([]);
  });

  it("returns null and creates nothing when the slug is taken", async () => {
    const { org: existing } = await createTestTenant(admin.db);
    const values = { ...input(), slug: existing.slug };
    expect(await signupCreateOrg(app.db, values)).toBeNull();
    expect(await admin.db.select().from(appUser).where(eq(appUser.id, values.userId))).toEqual([]);
  });
});
