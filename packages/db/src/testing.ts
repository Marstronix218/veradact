// Test helpers (`@veradact/db/testing`). Integration tests run against veradact_test, which
// the root Vitest globalSetup resets and migrates once per run. Test files run
// concurrently, so every test creates its own orgs with random ids and never truncates
// shared tables.
import { randomBytes, randomUUID } from "node:crypto";
import { createDb, type CreateDbOptions, type DbHandle, type Db } from "./client";
import { loadRootEnv, requireEnv } from "./env";
import { getPgError, type PgErrorInfo } from "./errors";
import { appUser, clientContact, engagement, event, org, ZERO_HASH } from "./schema";
import type { Tx } from "./tenant";

loadRootEnv();

type OrgInsert = typeof org.$inferInsert;
type AppUserInsert = typeof appUser.$inferInsert;
type EngagementInsert = typeof engagement.$inferInsert;
type EventInsert = typeof event.$inferInsert;

export type TestOrg = typeof org.$inferSelect;
export type TestUser = typeof appUser.$inferSelect;
export type TestEngagement = typeof engagement.$inferSelect;
export type TestContact = typeof clientContact.$inferSelect;
export type TestEvent = typeof event.$inferSelect;

/**
 * App role (`veradact_app`, RLS enforced). Close it in `afterAll`. Pools are small because
 * test files run in parallel against one server (max_connections = 100).
 */
export function testDb(options: CreateDbOptions = { max: 3 }): DbHandle {
  return createDb(requireEnv("TEST_DATABASE_URL"), options);
}

/** Owner role (bypasses RLS). For fixtures and for simulating what the app cannot do. */
export function adminTestDb(options: CreateDbOptions = { max: 3 }): DbHandle {
  return createDb(requireEnv("TEST_DATABASE_ADMIN_URL"), options);
}

/**
 * Awaits a promise that must reject with a Postgres error and returns that error's
 * SQLSTATE/message (unwrapping Drizzle's wrapper). Throws if it resolves or fails otherwise.
 */
export async function catchPgError(promise: Promise<unknown>): Promise<PgErrorInfo> {
  try {
    await promise;
  } catch (error) {
    const info = getPgError(error);
    if (info) return info;
    throw error;
  }
  throw new Error("catchPgError: expected a Postgres error, but the query succeeded");
}

/** 64 random lowercase hex chars: a syntactically valid hash, not a real one. */
export function randomHash(): string {
  return randomBytes(32).toString("hex");
}

const SHORT_CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function randomShortCode(length = 6): string {
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => SHORT_CODE_CHARS[b % SHORT_CODE_CHARS.length]).join("");
}

/** Synthetic org (admin connection; orgs are never created by the app role). */
export async function createTestOrg(admin: Db, overrides: Partial<OrgInsert> = {}): Promise<TestOrg> {
  const id = overrides.id ?? randomUUID();
  const [row] = await admin
    .insert(org)
    .values({
      id,
      name: `Test Org ${id.slice(0, 8)}`,
      slug: `test-${id}`,
      createdAt: new Date(),
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("createTestOrg: insert returned no row");
  return row;
}

export async function createTestUser(
  admin: Db,
  values: Pick<AppUserInsert, "orgId"> & Partial<AppUserInsert>,
): Promise<TestUser> {
  const id = values.id ?? randomUUID();
  const [row] = await admin
    .insert(appUser)
    .values({
      id,
      email: `user-${id}@example.test`,
      name: "Test User",
      role: "admin",
      createdAt: new Date(),
      ...values,
    })
    .returning();
  if (!row) throw new Error("createTestUser: insert returned no row");
  return row;
}

/** Engagement row only (no events). Creates a user for `createdBy` unless given. */
export async function createTestEngagement(
  admin: Db,
  values: Pick<EngagementInsert, "orgId"> & Partial<EngagementInsert>,
): Promise<TestEngagement> {
  const createdBy = values.createdBy ?? (await createTestUser(admin, { orgId: values.orgId })).id;
  const [row] = await admin
    .insert(engagement)
    .values({
      name: "Test Engagement",
      clientName: "Test Client Co",
      shortCode: randomShortCode(),
      timeZone: "America/New_York",
      createdAt: new Date(),
      ...values,
      createdBy,
    })
    .returning();
  if (!row) throw new Error("createTestEngagement: insert returned no row");
  return row;
}

export async function createTestContact(
  admin: Db,
  values: { orgId: string; engagementId: string },
): Promise<TestContact> {
  const [row] = await admin
    .insert(clientContact)
    .values({ ...values, createdAt: new Date() })
    .returning();
  if (!row) throw new Error("createTestContact: insert returned no row");
  return row;
}

export interface TestTenant {
  org: TestOrg;
  user: TestUser;
  engagement: TestEngagement;
}

/** Org + admin user + engagement, the usual starting point. */
export async function createTestTenant(admin: Db): Promise<TestTenant> {
  const testOrg = await createTestOrg(admin);
  const user = await createTestUser(admin, { orgId: testOrg.id });
  const testEngagement = await createTestEngagement(admin, { orgId: testOrg.id, createdBy: user.id });
  return { org: testOrg, user, engagement: testEngagement };
}

export interface ChainHead {
  seq: number;
  hash: string;
  recordedAt: Date;
}

/**
 * Inserts `count` events that satisfy the database's chain checks (seq, prev_hash,
 * monotonic recorded_at) but carry RANDOM hashes and placeholder payloads. For DB-layer
 * tests only; real events go through the append API, whose hashes verifyChain checks.
 */
export async function insertRawEvents(
  db: Db | Tx,
  target: { orgId: string; engagementId: string; head?: ChainHead | null },
  count = 1,
  overrides: Partial<EventInsert> = {},
): Promise<TestEvent[]> {
  const rows: TestEvent[] = [];
  let head = target.head ?? null;
  for (let i = 0; i < count; i++) {
    const recordedAt = new Date(Math.max(Date.now(), head ? head.recordedAt.getTime() : 0));
    const [row] = await db
      .insert(event)
      .values({
        orgId: target.orgId,
        engagementId: target.engagementId,
        seq: head ? head.seq + 1 : 1,
        type: "test_event",
        schemaVersion: 1,
        payload: { n: i },
        actorType: "system",
        actorId: null,
        occurredAt: recordedAt,
        recordedAt,
        prevHash: head ? head.hash : ZERO_HASH,
        hash: randomHash(),
        ...overrides,
      })
      .returning();
    if (!row) throw new Error("insertRawEvents: insert returned no row");
    rows.push(row);
    head = { seq: row.seq, hash: row.hash, recordedAt: row.recordedAt };
  }
  return rows;
}
