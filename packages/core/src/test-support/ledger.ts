// Integration-test helpers for the store and commands (test-only; not exported from the package).
// Tests run in parallel against one database, so every helper creates fresh orgs and ids.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { appUser, clientContact, engagement, org, withTenant, type Db, type DbHandle, type Tx } from "@veradact/db";
import { createTestOrg, createTestUser } from "@veradact/db/testing";
import { steppingClock, type GeneratedEngagement } from "../domain/testing";
import type { CommandContext } from "../commands/context";
import { createEngagement } from "../commands/engagements";
import { ingestSource } from "../commands/sources";

export interface LedgerTenant {
  orgId: string;
  userId: string;
}

/** Org + admin user (created with the admin connection, like `pnpm org:create`). */
export async function createLedgerTenant(admin: Db): Promise<LedgerTenant> {
  const o = await createTestOrg(admin);
  const u = await createTestUser(admin, { orgId: o.id });
  return { orgId: o.id, userId: u.id };
}

/** A second user in the same org. */
export async function createLedgerUser(admin: Db, orgId: string): Promise<string> {
  return (await createTestUser(admin, { orgId, role: "member" })).id;
}

/** A command context on the app role with a stepping fake clock (1 s per call by default). */
export function ledgerContext(
  app: DbHandle,
  tenant: LedgerTenant,
  start = new Date("2026-03-02T15:00:00.000Z"),
  stepMs = 1000,
): CommandContext & { db: Db } {
  return { db: app.db, orgId: tenant.orgId, userId: tenant.userId, clock: steppingClock(start, stepMs) };
}

/** Runs `fn` in the tenant's RLS context. */
export function inTenant<T>(app: DbHandle, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenant(app.db, { orgId }, fn);
}

/**
 * Creates the rows a generated engagement refers to: the org (admin, idempotent), then — as the
 * app role inside `tx` — its users, the engagement row and the client contacts. The engagement row
 * must exist before its genesis event.
 */
export async function insertGeneratedFixtures(admin: Db, tx: Tx, gen: GeneratedEngagement): Promise<void> {
  await admin
    .insert(org)
    .values({ id: gen.orgId, name: `Synthetic Org ${gen.orgId.slice(0, 8)}`, slug: `synthetic-${gen.orgId}`, createdAt: new Date() })
    .onConflictDoNothing();
  const createdAt = new Date("2025-01-01T00:00:00.000Z");
  await tx.insert(appUser).values(
    gen.userIds.map((id) => ({ id, orgId: gen.orgId, email: `user-${id}@example.test`, name: "Synthetic User", role: "member" as const, createdAt })),
  );
  await tx.insert(engagement).values({
    id: gen.engagementId,
    orgId: gen.orgId,
    name: "Synthetic engagement",
    clientName: "Fictional Client Co",
    shortCode: gen.shortCode,
    timeZone: gen.timeZone,
    createdBy: gen.userIds[0]!,
    createdAt,
  });
  await tx.insert(clientContact).values(gen.contactIds.map((id) => ({ id, orgId: gen.orgId, engagementId: gen.engagementId, createdAt })));
}

/** Sentinel used to roll back a transaction on purpose. */
export class Rollback extends Error {
  constructor() {
    super("rollback");
  }
}

/** Runs `fn` in a tenant transaction that is always rolled back; returns fn's result. */
export async function inRolledBackTenant<T>(app: DbHandle, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  let result: { value: T } | undefined;
  try {
    await withTenant(app.db, { orgId }, async (tx) => {
      result = { value: await fn(tx) };
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  if (!result) throw new Error("inRolledBackTenant: no result");
  return result.value;
}

/** Simulates tampering as the owner with triggers off (`session_replication_role = replica`). */
export async function tamper(admin: Db, statement: ReturnType<typeof sql>): Promise<void> {
  await admin.transaction(async (tx) => {
    await tx.execute(sql`set local session_replication_role = replica`);
    await tx.execute(statement);
  });
}

export function uuid(): string {
  return randomUUID();
}

/** Synthetic meeting notes (fictional people and companies). Each quoted line appears once. */
export const NOTES_TEXT = [
  "Kickoff call, Halvorsen Freight.",
  "Dana: The dispatch dashboard must refresh every five minutes.",
  "Lee: Invoices are exported nightly to the carrier portal.",
  "Dana: We assume carriers accept CSV uploads.",
  "Lee: Use the existing SSO provider for staff logins.",
  "Dana: Route changes need approval within 48h.",
  "",
].join("\n");

export interface LedgerEngagement extends LedgerTenant {
  ctx: CommandContext & { db: Db };
  engagementId: string;
  shortCode: string;
  sourceId: string;
  sourceOccurredAt: Date;
}

/**
 * Org + user + engagement (createEngagement) + one human-notes source with NOTES_TEXT, all through
 * the commands with a stepping clock starting at `start`.
 */
export async function createLedgerEngagement(
  app: DbHandle,
  admin: Db,
  start = new Date("2026-03-02T15:00:00.000Z"),
): Promise<LedgerEngagement> {
  const tenant = await createLedgerTenant(admin);
  const ctx = ledgerContext(app, tenant, start);
  const shortCode = "HALV";
  const { engagementId } = await createEngagement(ctx, {
    name: "Synthetic engagement",
    clientName: "Fictional Client Co",
    shortCode,
    timeZone: "America/New_York",
  });
  const sourceOccurredAt = new Date("2026-02-20T14:00:00.000Z");
  const { sourceId } = await ingestSource(ctx, {
    engagementId,
    parsed: { text: NOTES_TEXT, rawText: NOTES_TEXT, segments: [] },
    title: "Kickoff notes",
    filename: "kickoff.md",
    format: "md",
    sourceType: "human_notes",
    occurredAt: sourceOccurredAt,
    participants: ["Dana", "Lee"],
    attestation: { allParticipantsConsented: null, jurisdictions: [], jurisdictionsKnown: false },
  });
  return { ...tenant, ctx, engagementId, shortCode, sourceId, sourceOccurredAt };
}

/** A command context for the client actions of a contact (same db and clock as `ctx`). */
export function clientContext(ctx: CommandContext & { db: Db }): { db: Db; orgId: string; clock: () => Date } {
  return { db: ctx.db, orgId: ctx.orgId, clock: ctx.clock };
}
