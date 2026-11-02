// Invariant 7 (tenant isolation). ARCHITECTURE §7 tests: catalog sweep + cross-tenant
// read/write for EVERY tenant table, driven by CASES. A table that gets RLS but no case
// (or a case for a table that no longer exists) fails "CASES covers every table".
import { randomBytes, randomUUID } from "node:crypto";
import { getTableColumns, getTableName, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client";
import {
  apiToken,
  appUser,
  auditLog,
  candidate,
  clientContact,
  confirmationEvidence,
  confirmationLink,
  confirmationRequest,
  confirmationRequestContact,
  confirmationRequestItem,
  contactAuthorization,
  contactPii,
  engagement,
  engagementHead,
  event,
  eventNote,
  extractionRun,
  item,
  itemDependency,
  itemResponse,
  itemVersion,
  loginToken,
  notification,
  org,
  responseComment,
  session,
  source,
  sourceContent,
  usageEvent,
  ZERO_HASH,
} from "./schema";
import { withTenant, type Tx } from "./tenant";
import {
  adminTestDb,
  catchPgError,
  createTestContact,
  createTestEngagement,
  createTestTenant,
  insertRawEvents,
  randomHash,
  randomShortCode,
  testDb,
  type TestContact,
  type TestEngagement,
  type TestEvent,
  type TestOrg,
  type TestUser,
} from "./testing";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

/** Public tables deliberately without RLS: no tenant data. */
const RLS_ALLOW_LIST = ["rate_limit_bucket"];

/** Tables a foreign key may point at (ARCHITECTURE §2 FK rule). */
const FK_TARGETS = ["org", "app_user", "engagement", "client_contact", "event"];

const INSUFFICIENT_PRIVILEGE = "42501";
const FOREIGN_KEY_VIOLATION = "23503";

interface Fixture {
  org: TestOrg;
  user: TestUser;
  engagement: TestEngagement;
  contact: TestContact;
  event: TestEvent;
}

type Row = Record<string, unknown>;

interface TenantCase {
  table: PgTable;
  /** Grants to veradact_app (migration 0002). */
  privileges: { insert: boolean; update: boolean; delete: boolean };
  /** False when the fixture already created this table's row for each org. */
  seed?: boolean;
  /** A new row owned by fixture `f`, with fresh unique keys on every call. */
  row: (f: Fixture) => Promise<Row> | Row;
}

const ALL = { insert: true, update: true, delete: true };
const APPEND_ONLY = { insert: true, update: false, delete: false };
const READ_ONLY = { insert: false, update: false, delete: false };

let counter = 1_000;
const next = () => counter++;
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

/** A fresh engagement of `f`'s org with a genesis event (for rows keyed by event id). */
async function newEvent(f: Fixture): Promise<TestEvent> {
  const e = await createTestEngagement(admin.db, { orgId: f.org.id, createdBy: f.user.id });
  const [row] = await insertRawEvents(admin.db, { orgId: f.org.id, engagementId: e.id });
  return row!;
}

const CASES: Record<string, TenantCase> = {
  // §2.1 tenancy and identity
  org: {
    table: org,
    privileges: { insert: false, update: true, delete: false },
    seed: false,
    row: (f) => ({ id: f.org.id, name: "Org", slug: `t-${randomUUID()}`, createdAt: new Date() }),
  },
  app_user: {
    table: appUser,
    privileges: ALL,
    row: (f) => ({
      orgId: f.org.id,
      email: `member-${randomUUID()}@example.test`,
      name: "Member",
      role: "member",
      createdAt: new Date(),
    }),
  },
  login_token: {
    table: loginToken,
    privileges: ALL,
    row: (f) => ({
      orgId: f.org.id,
      userId: f.user.id,
      tokenHash: randomHash(),
      expiresAt: later(15),
      createdAt: new Date(),
    }),
  },
  session: {
    table: session,
    privileges: ALL,
    row: (f) => ({
      orgId: f.org.id,
      userId: f.user.id,
      tokenHash: randomHash(),
      expiresAt: later(60),
      createdAt: new Date(),
    }),
  },
  api_token: {
    table: apiToken,
    privileges: ALL,
    row: (f) => ({
      orgId: f.org.id,
      userId: f.user.id,
      name: "agent",
      tokenPrefix: "vdt_test",
      tokenHash: randomHash(),
      createdAt: new Date(),
    }),
  },
  engagement: {
    table: engagement,
    privileges: ALL,
    row: (f) => ({
      orgId: f.org.id,
      name: "Engagement",
      clientName: "Client Co",
      shortCode: randomShortCode(8),
      timeZone: "Europe/Oslo",
      createdBy: f.user.id,
      createdAt: new Date(),
    }),
  },
  client_contact: {
    table: clientContact,
    privileges: ALL,
    row: (f) => ({ orgId: f.org.id, engagementId: f.engagement.id, createdAt: new Date() }),
  },
  contact_pii: {
    table: contactPii,
    privileges: ALL,
    row: async (f) => ({
      contactId: (await createTestContact(admin.db, { orgId: f.org.id, engagementId: f.engagement.id })).id,
      orgId: f.org.id,
      name: "Pat Example",
      email: "pat@example.test",
      hmacKey: randomBytes(32),
    }),
  },
  // §2.2 log
  event: {
    table: event,
    privileges: APPEND_ONLY,
    row: async (f) => {
      // Genesis of a fresh engagement, so the chain trigger accepts it.
      const e = await createTestEngagement(admin.db, { orgId: f.org.id, createdBy: f.user.id });
      const at = new Date();
      return {
        orgId: f.org.id,
        engagementId: e.id,
        seq: 1,
        type: "test_event",
        schemaVersion: 1,
        payload: {},
        actorType: "system",
        occurredAt: at,
        recordedAt: at,
        prevHash: ZERO_HASH,
        hash: randomHash(),
      };
    },
  },
  engagement_head: {
    table: engagementHead,
    privileges: READ_ONLY,
    seed: false,
    row: async (f) => ({
      engagementId: (await createTestEngagement(admin.db, { orgId: f.org.id, createdBy: f.user.id })).id,
      orgId: f.org.id,
      headSeq: 1,
      headHash: randomHash(),
      headRecordedAt: new Date(),
    }),
  },
  // §2.3 projections
  source: {
    table: source,
    privileges: ALL,
    row: (f) => ({
      id: randomUUID(),
      orgId: f.org.id,
      engagementId: f.engagement.id,
      sourceType: "human_notes",
      format: "txt",
      occurredAt: new Date(),
      recordedAt: new Date(),
      contentSha256: randomHash(),
      charLength: 42,
      participantCount: 2,
      attestation: { attested_by: f.user.id },
      ingestedBy: f.user.id,
    }),
  },
  item: {
    table: item,
    privileges: ALL,
    row: (f) => ({
      id: randomUUID(),
      orgId: f.org.id,
      engagementId: f.engagement.id,
      shortId: `${f.engagement.shortCode}-R${next()}`,
      kind: "requirement",
      currentVersion: 1,
      status: "pending",
      lifecycle: "active",
      needsReview: false,
      reviewReasons: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSeq: 1,
    }),
  },
  item_version: {
    table: itemVersion,
    privileges: ALL,
    row: (f) => ({
      itemId: randomUUID(),
      version: 1,
      orgId: f.org.id,
      engagementId: f.engagement.id,
      contentHash: randomHash(),
      statement: "Synthetic statement",
      spans: [],
      manual: { entered_by: f.user.id },
      provenance: { via: "manual" },
      occurredAt: new Date(),
      recordedAt: new Date(),
      eventSeq: next(),
    }),
  },
  item_dependency: {
    table: itemDependency,
    privileges: ALL,
    row: (f) => ({
      orgId: f.org.id,
      engagementId: f.engagement.id,
      itemId: randomUUID(),
      dependsOnItemId: randomUUID(),
      addedSeq: next(),
    }),
  },
  item_response: {
    table: itemResponse,
    privileges: ALL,
    row: (f) => ({
      orgId: f.org.id,
      engagementId: f.engagement.id,
      eventSeq: next(),
      itemId: randomUUID(),
      version: 1,
      contentHash: randomHash(),
      contactId: f.contact.id,
      requestId: randomUUID(),
      submissionId: randomUUID(),
      response: "confirmed",
      recordedAt: new Date(),
    }),
  },
  confirmation_request: {
    table: confirmationRequest,
    privileges: ALL,
    row: (f) => ({
      id: randomUUID(),
      orgId: f.org.id,
      engagementId: f.engagement.id,
      requestedBy: f.user.id,
      expiresAt: later(14 * 24 * 60),
      recordedAt: new Date(),
      eventSeq: next(),
    }),
  },
  confirmation_request_item: {
    table: confirmationRequestItem,
    privileges: ALL,
    row: (f) => ({
      orgId: f.org.id,
      engagementId: f.engagement.id,
      requestId: randomUUID(),
      itemId: randomUUID(),
      version: 1,
      contentHash: randomHash(),
    }),
  },
  confirmation_request_contact: {
    table: confirmationRequestContact,
    privileges: ALL,
    row: (f) => ({
      orgId: f.org.id,
      engagementId: f.engagement.id,
      requestId: randomUUID(),
      contactId: f.contact.id,
    }),
  },
  contact_authorization: {
    table: contactAuthorization,
    privileges: ALL,
    row: (f) => ({
      orgId: f.org.id,
      engagementId: f.engagement.id,
      contactId: randomUUID(),
      requestId: randomUUID(),
      decision: "granted",
      textVersion: "v1",
      textSha256: randomHash(),
      recordedAt: new Date(),
      eventSeq: next(),
    }),
  },
  // §2.4 operational
  source_content: {
    table: sourceContent,
    privileges: ALL,
    row: (f) => ({
      sourceId: randomUUID(),
      orgId: f.org.id,
      engagementId: f.engagement.id,
      title: "Kickoff notes",
      filename: "kickoff.txt",
      text: "Synthetic source text.",
      rawText: "Synthetic source text.",
    }),
  },
  event_note: {
    table: eventNote,
    privileges: ALL,
    row: async (f) => ({ eventId: (await newEvent(f)).id, orgId: f.org.id, note: "Synthetic note" }),
  },
  extraction_run: {
    table: extractionRun,
    privileges: ALL,
    row: (f) => ({
      orgId: f.org.id,
      engagementId: f.engagement.id,
      sourceId: randomUUID(),
      model: "test-model",
      promptVersion: "extract.v1",
      status: "running",
      createdAt: new Date(),
    }),
  },
  candidate: {
    table: candidate,
    privileges: ALL,
    row: (f) => ({
      orgId: f.org.id,
      engagementId: f.engagement.id,
      sourceId: randomUUID(),
      extractionRunId: randomUUID(),
      ordinal: 1,
      kind: "requirement",
      statement: "Synthetic statement",
      quote: "Synthetic",
      start: 0,
      end: 9,
      verification: "exact",
      createdAt: new Date(),
    }),
  },
  confirmation_link: {
    table: confirmationLink,
    privileges: ALL,
    row: (f) => ({
      orgId: f.org.id,
      engagementId: f.engagement.id,
      requestId: randomUUID(),
      contactId: f.contact.id,
      sentToEmail: "pat@example.test",
      expiresAt: later(14 * 24 * 60),
      createdAt: new Date(),
    }),
  },
  confirmation_evidence: {
    table: confirmationEvidence,
    privileges: ALL,
    row: async (f) => ({
      eventId: (await newEvent(f)).id,
      orgId: f.org.id,
      contactId: f.contact.id,
      name: "Pat Example",
      email: "pat@example.test",
      ip: "192.0.2.1",
      userAgent: "test-agent",
    }),
  },
  response_comment: {
    table: responseComment,
    privileges: ALL,
    row: async (f) => ({
      eventId: (await newEvent(f)).id,
      orgId: f.org.id,
      contactId: f.contact.id,
      comment: "Synthetic comment",
    }),
  },
  notification: {
    table: notification,
    privileges: ALL,
    row: (f) => ({
      orgId: f.org.id,
      userId: f.user.id,
      engagementId: f.engagement.id,
      kind: "item_disputed",
      itemId: randomUUID(),
      contactId: f.contact.id,
      createdAt: new Date(),
    }),
  },
  usage_event: {
    table: usageEvent,
    privileges: ALL,
    row: (f) => ({
      orgId: f.org.id,
      engagementId: f.engagement.id,
      kind: "spec_export",
      userId: f.user.id,
      createdAt: new Date(),
    }),
  },
  audit_log: {
    table: auditLog,
    privileges: APPEND_ONLY,
    row: (f) => ({
      orgId: f.org.id,
      actorUserId: f.user.id,
      action: "engagement.create",
      targetType: "engagement",
      targetId: f.engagement.id,
      createdAt: new Date(),
    }),
  },
};

async function createFixture(): Promise<Fixture> {
  const tenant = await createTestTenant(admin.db);
  const contact = await createTestContact(admin.db, {
    orgId: tenant.org.id,
    engagementId: tenant.engagement.id,
  });
  const [genesis] = await insertRawEvents(admin.db, {
    orgId: tenant.org.id,
    engagementId: tenant.engagement.id,
  });
  return { ...tenant, contact, event: genesis! };
}

function insert(db: Db | Tx, table: PgTable, row: Row) {
  return db.insert(table).values(row as never);
}

/** Runs `fn` as the app role in org `orgId`, then rolls back. */
async function inRolledBackTenantTx(orgId: string, fn: (tx: Tx) => Promise<void>): Promise<void> {
  const ROLLBACK = Symbol("rollback");
  try {
    await withTenant(app.db, { orgId }, async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}

let a: Fixture;
let b: Fixture;

beforeAll(async () => {
  [a, b] = await Promise.all([createFixture(), createFixture()]);
  for (const c of Object.values(CASES)) {
    if (c.seed === false) continue;
    for (const f of [a, b]) await insert(admin.db, c.table, await c.row(f));
  }
});

describe("catalog", () => {
  it("CASES covers every table with RLS, and nothing else", async () => {
    const rows = await admin.db.execute<{ relname: string }>(sql`
      select c.relname from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')`);
    const tenantTables = rows.map((r) => r.relname).filter((name) => !RLS_ALLOW_LIST.includes(name));
    expect(tenantTables.sort()).toEqual(Object.keys(CASES).sort());
    for (const [name, c] of Object.entries(CASES)) expect(getTableName(c.table)).toBe(name);
  });

  it("every public table except the allow-list has RLS, a tenant column and the tenant policy", async () => {
    const rows = await admin.db.execute<{
      relname: string;
      relkind: string;
      rls: boolean;
      has_org_id: boolean;
      policy_using: string | null;
      policy_check: string | null;
    }>(sql`
      select c.relname, c.relkind::text as relkind, c.relrowsecurity as rls,
             exists (select 1 from pg_attribute a
                      where a.attrelid = c.oid and a.attname = 'org_id' and a.attnum > 0
                        and not a.attisdropped) as has_org_id,
             (select pg_get_expr(p.polqual, c.oid) from pg_policy p
               where p.polrelid = c.oid and p.polname = 'tenant_isolation' and p.polcmd = '*') as policy_using,
             (select pg_get_expr(p.polwithcheck, c.oid) from pg_policy p
               where p.polrelid = c.oid and p.polname = 'tenant_isolation' and p.polcmd = '*') as policy_check
        from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')`);
    expect(rows.length).toBeGreaterThan(RLS_ALLOW_LIST.length);

    for (const name of RLS_ALLOW_LIST) {
      expect(rows.find((r) => r.relname === name), `allow-listed ${name} exists`).toBeDefined();
    }
    for (const row of rows.filter((r) => !RLS_ALLOW_LIST.includes(r.relname))) {
      const tenantColumn = row.relname === "org" ? "id" : "org_id";
      const expected = `(${tenantColumn} = app_current_org())`;
      expect({ table: row.relname, kind: row.relkind, rls: row.rls }).toEqual({
        table: row.relname,
        kind: "r",
        rls: true,
      });
      if (row.relname !== "org") expect(row.has_org_id, `${row.relname} has org_id`).toBe(true);
      expect({ table: row.relname, using: row.policy_using, check: row.policy_check }).toEqual({
        table: row.relname,
        using: expected,
        check: expected,
      });
    }
  });

  it("foreign keys only target org/app_user/engagement/client_contact/event, pin org_id and never cascade", async () => {
    const rows = await admin.db.execute<{
      source: string;
      target: string;
      columns: string[];
      target_columns: string[];
      on_delete: string;
      on_update: string;
    }>(sql`
      select con.conrelid::regclass::text as source, con.confrelid::regclass::text as target,
             array(select a.attname::text from unnest(con.conkey) with ordinality k(attnum, ord)
                     join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
                    order by k.ord) as columns,
             array(select a.attname::text from unnest(con.confkey) with ordinality k(attnum, ord)
                     join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum
                    order by k.ord) as target_columns,
             con.confdeltype::text as on_delete, con.confupdtype::text as on_update
        from pg_constraint con
       where con.contype = 'f' and con.connamespace = 'public'::regnamespace`);
    expect(rows.length).toBeGreaterThan(0);
    for (const fk of rows) {
      const label = `${fk.source}(${fk.columns.join(",")}) -> ${fk.target}`;
      expect(FK_TARGETS, label).toContain(fk.target);
      expect({ label, onDelete: fk.on_delete, onUpdate: fk.on_update }).toEqual({
        label,
        onDelete: "a",
        onUpdate: "a",
      });
      if (fk.target === "org") {
        expect(fk.columns, label).toEqual(["org_id"]);
      } else {
        // Composite (x_id, org_id) -> (id, org_id): a row can never point into another tenant.
        expect({ label, columns: fk.columns.length, orgPos: fk.columns.indexOf("org_id") }).toEqual({
          label,
          columns: 2,
          orgPos: 1,
        });
        expect(fk.target_columns, label).toEqual(["id", "org_id"]);
      }
    }
  });
});

describe.each(Object.entries(CASES))("%s", (name, c) => {
  const tenantColumn = name === "org" ? "id" : "org_id";
  const table = sql.identifier(name);
  const column = sql.identifier(tenantColumn);

  it("a tenant session sees only its own org's rows", async () => {
    const [counts] = await withTenant(app.db, { orgId: a.org.id }, (tx) =>
      tx.execute<{ own: number; other: number; of_b: number }>(sql`
        select count(*) filter (where ${column} = ${a.org.id}) as own,
               count(*) filter (where ${column} <> ${a.org.id}) as other,
               count(*) filter (where ${column} = ${b.org.id}) as of_b
          from ${table}`),
    );
    expect(counts?.own).toBeGreaterThan(0);
    expect(counts?.other).toBe(0);
    expect(counts?.of_b).toBe(0);
  });

  it("UPDATE and DELETE of another org's rows affect nothing", async () => {
    const update = (orgId: string) =>
      sql`update ${table} set ${column} = ${column} where ${column} = ${orgId} returning 1`;
    const remove = (orgId: string) => sql`delete from ${table} where ${column} = ${orgId} returning 1`;

    if (c.privileges.update) {
      await withTenant(app.db, { orgId: a.org.id }, async (tx) => {
        expect(await tx.execute(update(b.org.id))).toHaveLength(0);
        expect((await tx.execute(update(a.org.id))).length).toBeGreaterThan(0);
      });
    } else {
      const error = await catchPgError(
        withTenant(app.db, { orgId: a.org.id }, (tx) => tx.execute(update(b.org.id))),
      );
      expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    }

    if (c.privileges.delete) {
      await withTenant(app.db, { orgId: a.org.id }, async (tx) => {
        expect(await tx.execute(remove(b.org.id))).toHaveLength(0);
      });
      // Control: the same statement does reach org A's rows (deleted, or blocked only by
      // a foreign key from rows that reference them). Rolled back either way.
      await inRolledBackTenantTx(a.org.id, async (tx) => {
        try {
          expect((await tx.execute(remove(a.org.id))).length).toBeGreaterThan(0);
        } catch (error) {
          const info = await catchPgError(Promise.reject(error));
          expect(info.code).toBe(FOREIGN_KEY_VIOLATION);
        }
      });
    } else {
      const error = await catchPgError(
        withTenant(app.db, { orgId: a.org.id }, (tx) => tx.execute(remove(b.org.id))),
      );
      expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    }

    const [stillThere] = await admin.db.execute<{ n: number }>(
      sql`select count(*) as n from ${table} where ${column} = ${b.org.id}`,
    );
    expect(stillThere?.n).toBeGreaterThan(0);
  });

  it("INSERT of a row for another org fails", async () => {
    const error = await catchPgError(
      withTenant(app.db, { orgId: a.org.id }, async (tx) => insert(tx, c.table, await c.row(b))),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(error.message).toMatch(
      c.privileges.insert ? /new row violates row-level security policy/ : /permission denied/,
    );

    if (c.privileges.insert) {
      // Control: the same kind of row for the session's own org is accepted.
      const own = await c.row(a);
      await inRolledBackTenantTx(a.org.id, async (tx) => {
        await insert(tx, c.table, own);
      });
    }
  });

  it("a session without a tenant sees nothing and cannot insert", async () => {
    const [counts] = await app.db.transaction((tx) =>
      tx.execute<{ n: number }>(sql`select count(*) as n from ${table}`),
    );
    expect(counts?.n).toBe(0);

    const [emptySetting] = await app.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.org_id', '', true)`);
      return tx.execute<{ n: number }>(sql`select count(*) as n from ${table}`);
    });
    expect(emptySetting?.n).toBe(0);

    const own = await c.row(a);
    const error = await catchPgError(app.db.transaction((tx) => insert(tx, c.table, own)));
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("composite foreign keys reject references into another org", async () => {
    const fks = await admin.db.execute<{ columns: string[]; target: string }>(sql`
      select con.confrelid::regclass::text as target,
             array(select a.attname::text from unnest(con.conkey) with ordinality k(attnum, ord)
                     join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
                    order by k.ord) as columns
        from pg_constraint con
       where con.contype = 'f' and con.conrelid = ${name}::regclass`);
    const columnKeys = new Map(
      Object.entries(getTableColumns(c.table)).map(([key, col]) => [col.name, key]),
    );
    for (const fk of fks.filter((f) => f.target !== "org")) {
      const referencing = columnKeys.get(fk.columns[0]!)!;
      // An id that exists, but in org B. Engagements are fresh (no events, no head) so the
      // chain trigger and engagement_head's primary key let the insert reach the FK check.
      const foreignIds: Record<string, () => Promise<string | number>> = {
        app_user: async () => b.user.id,
        engagement: async () =>
          (await createTestEngagement(admin.db, { orgId: b.org.id, createdBy: b.user.id })).id,
        client_contact: async () => b.contact.id,
        event: async () => b.event.id,
      };
      const row = { ...(await c.row(a)), [referencing]: await foreignIds[fk.target]!() };
      const error = await catchPgError(insert(admin.db, c.table, row));
      expect({ fk: `${name}.${fk.columns[0]} -> ${fk.target}`, code: error.code }).toEqual({
        fk: `${name}.${fk.columns[0]} -> ${fk.target}`,
        code: FOREIGN_KEY_VIOLATION,
      });
    }
  });
});

describe("withTenant", () => {
  it("settings are transaction-local and never leak to the next use of a pooled connection", async () => {
    const single = testDb({ max: 1 });
    try {
      const inside = await withTenant(single.db, { orgId: a.org.id }, (tx) =>
        tx.execute<{ n: number }>(sql`select count(*) as n from org`),
      );
      expect(inside[0]?.n).toBe(1);
      const after = await single.db.execute<{ org: string | null; n: number }>(
        sql`select app_current_org() as org, (select count(*) from org) as n`,
      );
      expect(after[0]).toEqual({ org: null, n: 0 });
    } finally {
      await single.close();
    }
  });

  it("sets app.user_id when given", async () => {
    const [row] = await withTenant(app.db, { orgId: a.org.id, userId: a.user.id }, (tx) =>
      tx.execute<{ user_id: string }>(sql`select current_setting('app.user_id') as user_id`),
    );
    expect(row?.user_id).toBe(a.user.id);
  });

  it("rejects ids that are not UUIDs before touching the database", async () => {
    await expect(withTenant(app.db, { orgId: "not-a-uuid" }, async () => 1)).rejects.toThrow(/UUID/);
  });
});
