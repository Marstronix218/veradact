// Engagement commands, and invariant 7 (tenant isolation) through the command layer.
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { auditLog, engagement, withTenant } from "@veradact/db";
import { adminTestDb, testDb } from "@veradact/db/testing";
import { emptyState } from "../domain";
import { DomainError } from "../errors";
import { loadState, readEvents } from "../store";
import { createLedgerEngagement, createLedgerTenant, ledgerContext } from "../test-support/ledger";
import { addContact } from "./contacts";
import { archiveEngagement, createEngagement, isValidTimeZone, reactivateEngagement, updateEngagement } from "./engagements";
import { createItem } from "./items";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

const base = { name: "Synthetic engagement", clientName: "Fictional Client Co", timeZone: "Europe/Berlin" };

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(error instanceof DomainError)) throw new Error(`expected a DomainError, got ${String(error)}`);
  return error.code;
}

describe("createEngagement", () => {
  it("creates the row and the genesis event and audits engagement.create", async () => {
    const tenant = await createLedgerTenant(admin.db);
    const ctx = ledgerContext(app, tenant);
    const { engagementId, events, state } = await createEngagement(ctx, { ...base, shortCode: "QF1" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ seq: 1, type: "engagement_created", actor: { type: "user", id: tenant.userId } });
    expect(state.engagement).toMatchObject({ id: engagementId, shortCode: "QF1", timeZone: "Europe/Berlin" });

    await withTenant(app.db, { orgId: tenant.orgId }, async (tx) => {
      const [row] = await tx.select().from(engagement).where(eq(engagement.id, engagementId));
      expect(row).toMatchObject({ shortCode: "QF1", status: "active", createdBy: tenant.userId, createdAt: events[0]!.recordedAt });
      const audit = await tx.select().from(auditLog).where(and(eq(auditLog.targetId, engagementId), eq(auditLog.action, "engagement.create")));
      expect(audit).toHaveLength(1);
    });
  });

  it("validates the short code format and per-org uniqueness", async () => {
    const tenant = await createLedgerTenant(admin.db);
    const ctx = ledgerContext(app, tenant);
    for (const shortCode of ["A", "halv", "TOOLONGCODE", "HA-1", ""]) {
      expect(await codeOf(createEngagement(ctx, { ...base, shortCode }))).toBe("invalid_short_code");
    }
    await createEngagement(ctx, { ...base, shortCode: "DUP" });
    expect(await codeOf(createEngagement(ctx, { ...base, shortCode: "DUP" }))).toBe("short_code_taken");
    // Another org may use the same code.
    const other = await createLedgerTenant(admin.db);
    await expect(createEngagement(ledgerContext(app, other), { ...base, shortCode: "DUP" })).resolves.toBeDefined();
  });

  it("requires a valid IANA time zone and non-blank names", async () => {
    const tenant = await createLedgerTenant(admin.db);
    const ctx = ledgerContext(app, tenant);
    for (const timeZone of ["Mars/Olympus", "+05:00", "EST", "", "utc"]) {
      expect(await codeOf(createEngagement(ctx, { ...base, shortCode: "TZ", timeZone }))).toBe("invalid_time_zone");
    }
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/Argentina/Buenos_Aires")).toBe(true);
    expect(await codeOf(createEngagement(ctx, { ...base, shortCode: "NM", name: "   " }))).toBe("invalid_name");
  });
});

describe("updateEngagement / archive / reactivate", () => {
  it("appends engagement_updated with changed fields only and mirrors the row; short code is immutable", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const { events, state } = await updateEngagement(e.ctx, {
      engagementId: e.engagementId,
      name: "Renamed engagement",
      clientName: "Fictional Client Co",
      timeZone: "Asia/Tokyo",
    });
    expect(events[0]!.type).toBe("engagement_updated");
    expect(events[0]!.payload).toEqual({ name: "Renamed engagement", time_zone: "Asia/Tokyo" });
    expect(state.engagement).toMatchObject({ name: "Renamed engagement", timeZone: "Asia/Tokyo", shortCode: "HALV" });
    await withTenant(app.db, { orgId: e.orgId }, async (tx) => {
      const [row] = await tx.select().from(engagement).where(eq(engagement.id, e.engagementId));
      expect(row).toMatchObject({ name: "Renamed engagement", timeZone: "Asia/Tokyo", shortCode: "HALV" });
    });

    expect(await codeOf(updateEngagement(e.ctx, { engagementId: e.engagementId, shortCode: "NEW" }))).toBe("short_code_immutable");
    expect(await codeOf(updateEngagement(e.ctx, { engagementId: e.engagementId, name: "Renamed engagement" }))).toBe("nothing_to_update");
    expect(await codeOf(updateEngagement(e.ctx, { engagementId: e.engagementId, timeZone: "Nowhere/Land" }))).toBe("invalid_time_zone");
  });

  it("archive and reactivate change the row status only (no events)", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const before = await withTenant(app.db, { orgId: e.orgId }, (tx) => readEvents(tx, e.engagementId));
    await archiveEngagement(e.ctx, { engagementId: e.engagementId });
    const archived = await withTenant(app.db, { orgId: e.orgId }, (tx) => tx.select().from(engagement).where(eq(engagement.id, e.engagementId)));
    expect(archived[0]).toMatchObject({ status: "archived" });
    expect(archived[0]!.archivedAt).toBeInstanceOf(Date);
    await reactivateEngagement(e.ctx, { engagementId: e.engagementId });
    const active = await withTenant(app.db, { orgId: e.orgId }, (tx) => tx.select().from(engagement).where(eq(engagement.id, e.engagementId)));
    expect(active[0]).toMatchObject({ status: "active", archivedAt: null });
    const after = await withTenant(app.db, { orgId: e.orgId }, (tx) => readEvents(tx, e.engagementId));
    expect(after).toEqual(before);
  });
});

describe("tenant isolation through commands (invariant 7)", () => {
  it("org A's context cannot load, change or add to org B's engagement", async () => {
    const b = await createLedgerEngagement(app, admin.db);
    const a = await createLedgerTenant(admin.db);
    const ctxA = ledgerContext(app, a);

    const seenByA = await withTenant(app.db, { orgId: a.orgId }, (tx) => loadState(tx, b.engagementId));
    expect(seenByA).toEqual(emptyState());
    expect(await codeOf(updateEngagement(ctxA, { engagementId: b.engagementId, name: "Hijacked" }))).toBe("engagement_not_found");
    expect(await codeOf(createItem(ctxA, { engagementId: b.engagementId, kind: "requirement", statement: "Injected", manual: true }))).toBe(
      "engagement_not_found",
    );
    expect(await codeOf(addContact(ctxA, { engagementId: b.engagementId, name: "Mallory", email: "mallory@example.test" }))).toBe(
      "engagement_not_found",
    );
    await archiveEngagement(ctxA, { engagementId: b.engagementId }).catch(() => undefined);

    const stateB = await withTenant(app.db, { orgId: b.orgId }, (tx) => loadState(tx, b.engagementId));
    expect(stateB.items.size).toBe(0);
    expect(stateB.engagement?.name).toBe("Synthetic engagement");
    const rowB = await withTenant(app.db, { orgId: b.orgId }, (tx) => tx.select().from(engagement).where(eq(engagement.id, b.engagementId)));
    expect(rowB[0]?.status).toBe("active");
  });

  it("a caller-supplied transaction must be scoped to the command's org", async () => {
    const b = await createLedgerEngagement(app, admin.db);
    const a = await createLedgerTenant(admin.db);
    const error = await withTenant(app.db, { orgId: a.orgId }, (tx) =>
      createItem({ tx, orgId: b.orgId, userId: b.userId, clock: b.ctx.clock }, { engagementId: b.engagementId, kind: "problem", statement: "x", manual: true }),
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/not scoped/);
  });
});
