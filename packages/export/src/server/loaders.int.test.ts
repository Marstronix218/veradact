// DB-aware export loaders against real Postgres (app role, RLS enforced), with engagements built
// through the core commands.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createItem, eraseContact, reviseItem } from "@veradact/core";
import { confirmationEvidence, event, usageEvent, withTenant, type Tx } from "@veradact/db";
import { adminTestDb, createTestOrg, testDb } from "@veradact/db/testing";
import { renderRecordMarkdown } from "../record";
import { AI_OFF_NOTICE, NOT_CONFIRMED_HEADING } from "../spec";
import { loadExportContext, loadRecord, loadSpec, parseAsOf, recordUsage, resolveEngagementRef, resolveItemRef } from "./index";
import { createExportScenario, DISPUTE_COMMENT, onFirstEventRead, SCENARIO_TIME_ZONE, type ExportScenario } from "./testing";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

const NOW = new Date("2026-11-01T14:00:00.000Z");
const clock = () => new Date(NOW.getTime());

function inTenant<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenant(app.db, { orgId }, fn);
}

function splitSpec(markdown: string): { confirmed: string; notConfirmed: string } {
  const [confirmed, notConfirmed, ...rest] = markdown.split(`## ${NOT_CONFIRMED_HEADING}`);
  expect(rest).toHaveLength(0);
  expect(notConfirmed).toBeDefined();
  return { confirmed: confirmed!, notConfirmed: notConfirmed! };
}

/** The `confirmation_evidence` row id of a contact's response to an item. */
async function responseEventId(s: ExportScenario, itemId: string, contactId: string): Promise<number> {
  const rows = await admin.db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.engagementId, s.engagementId),
        sql`${event.type} in ('item_confirmed', 'item_disputed')`,
        sql`${event.payload}->>'item_id' = ${itemId}`,
        sql`${event.payload}->>'contact_id' = ${contactId}`,
      ),
    );
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

describe("loadSpec", () => {
  it("contains only confirmed items, and every other active item under the do-not-build section", async () => {
    const s = await createExportScenario(app, admin.db);
    const { r1, d1, r2, a1, c1 } = s.items;
    const { markdown, filename, view, ctx } = await inTenant(s.orgId, (tx) => loadSpec(tx, { engagementId: s.engagementId, clock }));

    expect(view.items.map((i) => i.shortId)).toEqual([d1.shortId, r1.shortId]);
    expect(view.notConfirmed.map((i) => i.shortId).sort()).toEqual([a1.shortId, c1.shortId, r2.shortId].sort());
    expect(filename).toBe("HALV-spec-2026-11-01.md");
    expect(ctx.asOf).toBeNull();
    expect(ctx.generatedAt.toISOString()).toBe(NOW.toISOString());

    const { confirmed, notConfirmed } = splitSpec(markdown);
    for (const item of [r1, d1]) {
      expect(confirmed).toContain(`### ${item.shortId} · ${item.statement}`);
      expect(confirmed).toContain(item.contentHash);
      expect(confirmed).toContain(`> ${item.quote}`);
      expect(notConfirmed).not.toContain(item.shortId);
    }
    expect(confirmed).toContain("Kickoff notes");
    expect(confirmed).toMatch(/Confirmed by:\*\* Ada Client \(2026-03-03\), Ben Client \(2026-03-03\)/);
    for (const item of [r2, a1, c1]) {
      expect(confirmed).not.toContain(item.shortId);
      expect(confirmed).not.toContain(item.statement);
      expect(notConfirmed).toContain(`- ${item.shortId} · ${item.statement}`);
    }
    expect(notConfirmed).toContain(`${a1.shortId} · ${a1.statement} (disputed)`);
    expect(notConfirmed).toContain(`${r2.shortId} · ${r2.statement} (pending)`);
    // The dispute comment is client text and never part of the spec.
    expect(markdown).not.toContain(DISPUTE_COMMENT);
  });

  it("as_of in the past excludes confirmations recorded later", async () => {
    const s = await createExportScenario(app, admin.db);
    const { r1, d1, a1 } = s.items;
    const asOf = parseAsOf("2026-03-05", SCENARIO_TIME_ZONE);
    const { markdown, filename, view, ctx } = await inTenant(s.orgId, (tx) => loadSpec(tx, { engagementId: s.engagementId, asOf, clock }));

    expect(ctx.asOf?.toISOString()).toBe("2026-03-06T04:59:59.999Z");
    expect(view.items.map((i) => i.shortId)).toEqual([r1.shortId]);
    expect(filename).toBe("HALV-spec-2026-03-05.md");
    const { confirmed, notConfirmed } = splitSpec(markdown);
    expect(confirmed).toContain(`### ${r1.shortId} · ${r1.statement}`);
    expect(confirmed).not.toContain(d1.statement);
    expect(notConfirmed).toContain(`${d1.shortId} · ${d1.statement} (pending)`);
    // Disputed on day 8, so still pending at the as-of time.
    expect(notConfirmed).toContain(`${a1.shortId} · ${a1.statement} (pending)`);
    // The view reflects the log through the as-of time; the current head is printed separately.
    expect(view.head.seq).toBeLessThan(ctx.head.seq);
    expect(markdown).toContain(`**Current log head:** seq ${ctx.head.seq}`);
  });

  it("without as_of folds the whole log, even events recorded ahead of the reader's clock", async () => {
    const s = await createExportScenario(app, admin.db);
    const { r1, d1 } = s.items;
    // The writer's clock is ahead: R1 (confirmed Mar 3) is revised at Mar 20 while the reader's clock says Mar 15.
    s.clock.jump(new Date("2026-03-20T15:00:00.000Z"));
    const revised = "The dispatch dashboard refreshes every two minutes.";
    await reviseItem(s.ctx, { engagementId: s.engagementId, itemId: r1.itemId, statement: revised, reasonCode: "scope_change" });
    const readerClock = () => new Date("2026-03-15T12:00:00.000Z");

    const { markdown, view, ctx } = await inTenant(s.orgId, (tx) => loadSpec(tx, { engagementId: s.engagementId, clock: readerClock }));
    expect(view.head.seq).toBe(ctx.head.seq);
    expect(view.items.map((i) => i.shortId)).toEqual([d1.shortId]);
    expect(view.notConfirmed.find((i) => i.itemId === r1.itemId)).toMatchObject({ revisionPending: true, statement: revised });
    const { confirmed, notConfirmed } = splitSpec(markdown);
    expect(confirmed).not.toContain(`### ${r1.shortId}`);
    expect(notConfirmed).toContain(`- ${r1.shortId} · ${revised} (revision pending; previously agreed)`);

    // A reader clock before every event still sees the whole log.
    const early = await inTenant(s.orgId, (tx) => loadSpec(tx, { engagementId: s.engagementId, clock: () => new Date("2026-01-01T00:00:00.000Z") }));
    expect(early.view.head.seq).toBe(ctx.head.seq);
    expect(early.view.items.map((i) => i.shortId)).toEqual([d1.shortId]);
  });

  it.each([
    ["engagement", { engagementAiEnabled: false }],
    ["org", { orgAiEnabled: false }],
  ])("AI off (%s): the spec carries no quote text or source titles", async (_scope, options) => {
    const s = await createExportScenario(app, admin.db, options);
    const { markdown, ctx } = await inTenant(s.orgId, (tx) => loadSpec(tx, { engagementId: s.engagementId, clock }));
    expect(ctx.engagement.aiEnabled).toBe(false);
    expect(markdown).toContain(AI_OFF_NOTICE);
    expect(markdown).toContain(`### ${s.items.r1.shortId} · ${s.items.r1.statement}`);
    expect(markdown).toMatch(/Source:\*\* Human notes, 2026-02-20, characters \d+–\d+/);
    for (const item of Object.values(s.items)) if (item.quote) expect(markdown).not.toContain(item.quote);
    expect(markdown).not.toContain("Kickoff notes");
    expect(ctx.quoteFor({ source_id: s.sourceId, source_sha256: "0".repeat(64), start: 0, end: 5 })).toBeNull();
  });
});

describe("loadExportContext", () => {
  it("resolves names, sources and quotes, and refuses a quote whose source hash does not match", async () => {
    const s = await createExportScenario(app, admin.db);
    const { ctx, view } = await inTenant(s.orgId, (tx) => loadSpec(tx, { engagementId: s.engagementId, clock }));
    expect(ctx.engagement).toMatchObject({ shortCode: "HALV", timeZone: SCENARIO_TIME_ZONE, aiEnabled: true, name: "Dispatch portal rebuild" });
    expect(ctx.contactName(s.contacts.ada)).toBe("Ada Client");
    expect(ctx.userName(s.userId)).toBe("Alex Member");
    expect(ctx.sources[s.sourceId]).toMatchObject({ sourceType: "human_notes", title: "Kickoff notes", redactedAt: null });
    const span = view.items.find((i) => i.itemId === s.items.r1.itemId)!.spans[0]!;
    expect(ctx.quoteFor(span)).toBe(s.items.r1.quote);
    expect(ctx.quoteFor({ ...span, source_sha256: "f".repeat(64) })).toBeNull();
  });

  it("throws not_found for an unknown or foreign engagement", async () => {
    const s = await createExportScenario(app, admin.db);
    const other = await createTestOrg(admin.db);
    await expect(inTenant(other.id, (tx) => loadExportContext(tx, { engagementId: s.engagementId, clock }))).rejects.toMatchObject({ code: "not_found" });
    await expect(inTenant(s.orgId, (tx) => loadExportContext(tx, { engagementId: randomUUID(), clock }))).rejects.toMatchObject({ code: "not_found" });
    await expect(inTenant(s.orgId, (tx) => loadExportContext(tx, { engagementId: "HALV", clock }))).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("loadRecord", () => {
  it("verifies the chain and every evidence commitment", async () => {
    const s = await createExportScenario(app, admin.db);
    const { record, ctx } = await inTenant(s.orgId, (tx) => loadRecord(tx, { engagementId: s.engagementId, clock }));
    expect(record.verification.ok).toBe(true);
    expect(record.expectedHead).toEqual(ctx.head);
    expect(record.verification.headSeq).toBe(ctx.head.seq);
    expect(record.responses).toHaveLength(4);
    expect(record.responses.map((r) => r.evidence)).toEqual(["verified", "verified", "verified", "verified"]);
    const dispute = record.responses.find((r) => r.type === "item_disputed")!;
    expect(dispute.comment).toBe(DISPUTE_COMMENT);
    expect(record.authorizations.map((a) => a.decision)).toEqual(["granted", "granted"]);
    expect(record.authorizations.map((a) => a.evidence)).toEqual(["verified", "verified"]);
    // Five items at version 1: every content hash recomputes.
    expect(record.contentHashes).toEqual({ checked: 5, mismatches: [] });
    // The evidence snapshot's email domain is shown next to each responder (D-057).
    const domains = [...record.responses, ...record.authorizations].map((r) => r.emailDomain);
    expect(domains.every((d) => typeof d === "string" && /^[a-z0-9.-]+$/.test(d))).toBe(true);
    expect(renderRecordMarkdown(record, ctx)).toContain(`(@${domains[0]})`);
  });

  it("checks authorization evidence too: missing without a snapshot, erased after eraseContact", async () => {
    const s = await createExportScenario(app, admin.db);
    const [adaGrant] = await admin.db
      .select({ id: event.id })
      .from(event)
      .where(
        and(eq(event.engagementId, s.engagementId), eq(event.type, "authorization_granted"), sql`${event.payload}->>'contact_id' = ${s.contacts.ada}`),
      );
    await admin.db.delete(confirmationEvidence).where(eq(confirmationEvidence.eventId, adaGrant!.id));
    await eraseContact(s.ctx, { engagementId: s.engagementId, contactId: s.contacts.ben });
    const { record } = await inTenant(s.orgId, (tx) => loadRecord(tx, { engagementId: s.engagementId, clock }));
    const evidence = Object.fromEntries(record.authorizations.map((a) => [a.contactId, a.evidence]));
    expect(evidence).toEqual({ [s.contacts.ada]: "missing", [s.contacts.ben]: "erased" });
  });

  it.each(["before", "after"] as const)("reads engagement_head before the events: an append committing just %s the events read is not truncated", async (when) => {
    const s = await createExportScenario(app, admin.db);
    const append = async () => {
      // A second pool connection commits while the export transaction is open (READ COMMITTED).
      await createItem(s.ctx, { engagementId: s.engagementId, kind: "problem", statement: `Appended ${when} the events read.`, manual: true });
    };
    const { record, ctx } = await inTenant(s.orgId, (tx) => loadRecord(onFirstEventRead(tx, when, append), { engagementId: s.engagementId, clock }));
    expect(record.verification).toMatchObject({ ok: true });
    expect(record.expectedHead).toEqual(ctx.head);
    // Appended before the read: the record lists one event past the head it was checked against.
    expect(record.events.at(-1)!.seq).toBe(when === "before" ? ctx.head.seq + 1 : ctx.head.seq);
  });

  it("reports mismatch for a tampered snapshot, missing for a deleted one, erased after eraseContact", async () => {
    const s = await createExportScenario(app, admin.db);
    const { r1, d1, a1 } = s.items;
    const adaR1 = await responseEventId(s, r1.itemId, s.contacts.ada);
    const adaD1 = await responseEventId(s, d1.itemId, s.contacts.ada);
    await admin.db.update(confirmationEvidence).set({ ip: "198.51.100.77" }).where(eq(confirmationEvidence.eventId, adaR1));
    await admin.db.delete(confirmationEvidence).where(eq(confirmationEvidence.eventId, adaD1));
    await eraseContact(s.ctx, { engagementId: s.engagementId, contactId: s.contacts.ben });

    const { record } = await inTenant(s.orgId, (tx) => loadRecord(tx, { engagementId: s.engagementId, clock }));
    const status = (itemId: string, contactId: string) => {
      const shortId = Object.values(s.items).find((i) => i.itemId === itemId)!.shortId;
      return record.responses.find((r) => r.shortId === shortId && r.contactId === contactId)?.evidence;
    };
    expect(status(r1.itemId, s.contacts.ada)).toBe("mismatch");
    expect(status(d1.itemId, s.contacts.ada)).toBe("missing");
    expect(status(a1.itemId, s.contacts.ada)).toBe("verified");
    expect(status(r1.itemId, s.contacts.ben)).toBe("erased");
    // Erasure appends an event; the chain still verifies.
    expect(record.verification.ok).toBe(true);
    expect(record.events.at(-1)?.type).toBe("contact_erased");
  });

  it("renders a dispute comment as erased (null) once its contact is erased", async () => {
    const s = await createExportScenario(app, admin.db);
    await eraseContact(s.ctx, { engagementId: s.engagementId, contactId: s.contacts.ada });
    const { record, ctx } = await inTenant(s.orgId, (tx) => loadRecord(tx, { engagementId: s.engagementId, clock }));
    const dispute = record.responses.find((r) => r.type === "item_disputed")!;
    expect(dispute.evidence).toBe("erased");
    expect(dispute.comment).toBeNull();
    expect(ctx.contactName(s.contacts.ada)).toBeNull();
    expect(ctx.contactName(s.contacts.ben)).toBe("Ben Client");
  });
});

describe("recordUsage", () => {
  it("writes usage_event rows in the tenant", async () => {
    const s = await createExportScenario(app, admin.db);
    const apiTokenId = randomUUID();
    await inTenant(s.orgId, async (tx) => {
      await recordUsage(tx, { orgId: s.orgId, engagementId: s.engagementId, kind: "spec_export", userId: s.userId, at: NOW });
      await recordUsage(tx, { orgId: s.orgId, engagementId: null, kind: "mcp_fetch", userId: s.userId, apiTokenId, tool: "list_engagements", at: NOW });
    });
    const rows = await inTenant(s.orgId, (tx) => tx.select().from(usageEvent).where(eq(usageEvent.orgId, s.orgId)));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.kind === "spec_export")).toMatchObject({ engagementId: s.engagementId, userId: s.userId, apiTokenId: null, tool: null });
    expect(rows.find((r) => r.kind === "mcp_fetch")).toMatchObject({ engagementId: null, apiTokenId, tool: "list_engagements" });
    expect(rows.every((r) => r.createdAt.toISOString() === NOW.toISOString())).toBe(true);
  });
});

describe("resolveEngagementRef / resolveItemRef", () => {
  it("accept UUIDs, short codes and short ids case-insensitively", async () => {
    const s = await createExportScenario(app, admin.db);
    const { r1 } = s.items;
    await inTenant(s.orgId, async (tx) => {
      for (const ref of [s.engagementId, s.engagementId.toUpperCase(), "HALV", "halv", " Halv "]) {
        expect((await resolveEngagementRef(tx, ref))?.id).toBe(s.engagementId);
      }
      for (const ref of [r1.itemId, r1.itemId.toUpperCase(), "HALV-R1", "halv-r1"]) {
        expect(await resolveItemRef(tx, ref)).toEqual({ itemId: r1.itemId, engagementId: s.engagementId, shortId: "HALV-R1" });
      }
      for (const ref of ["NOPE", "", "HALV-R99", "HALV-X1", "HALV-R0", "not a ref", randomUUID()]) {
        expect(await resolveEngagementRef(tx, ref)).toBeNull();
        expect(await resolveItemRef(tx, ref)).toBeNull();
      }
    });
  });

  it("resolve another tenant's refs to null", async () => {
    const s = await createExportScenario(app, admin.db);
    const other = await createExportScenario(app, admin.db, { shortCode: "OTHR" });
    await inTenant(other.orgId, async (tx) => {
      expect(await resolveEngagementRef(tx, s.engagementId)).toBeNull();
      expect(await resolveEngagementRef(tx, "HALV")).toBeNull();
      expect(await resolveItemRef(tx, s.items.r1.itemId)).toBeNull();
      expect(await resolveItemRef(tx, "HALV-R1")).toBeNull();
      expect((await resolveEngagementRef(tx, "othr"))?.id).toBe(other.engagementId);
    });
  });
});
