// Item commands: invariant 5 (sourced or manual), invariant 6 (bitemporal), dependency flagging
// (D-011, D-024), short ids, and invariant 10 (only humans put items in the ledger).
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { itemVersion, withTenant } from "@veradact/db";
import { adminTestDb, testDb } from "@veradact/db/testing";
import { asOf, itemContentHash } from "../domain";
import { DomainError } from "../errors";
import { appendEvents, loadState, readEvents } from "../store";
import { clientContext, createLedgerEngagement, NOTES_TEXT, type LedgerEngagement } from "../test-support/ledger";
import { recordAuthorization, recordClientResponses, requestConfirmation } from "./confirmation";
import { addContact } from "./contacts";
import { addDependency, clearReview, createItem, removeDependency, reviseItem, supersedeItem, withdrawItem } from "./items";
import { AUTHORIZATION_TEXT_VERSION } from "../confirmation/authorization-text";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(error instanceof DomainError)) throw new Error(`expected a DomainError, got ${String(error)}`);
  return error.code;
}

const QUOTE = "The dispatch dashboard must refresh every five minutes.";

function sourced(e: LedgerEngagement, quote = QUOTE) {
  return { engagementId: e.engagementId, spans: [{ sourceId: e.sourceId, quote }] };
}

async function itemState(e: LedgerEngagement, itemId: string) {
  const state = await withTenant(app.db, { orgId: e.orgId }, (tx) => loadState(tx, e.engagementId));
  return state.items.get(itemId)!;
}

describe("sourced or manual (invariant 5)", () => {
  it("rejects an item with neither spans nor manual, and with both", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    expect(await codeOf(createItem(e.ctx, { engagementId: e.engagementId, kind: "requirement", statement: "No source" }))).toBe("sourced_or_manual");
    expect(await codeOf(createItem(e.ctx, { ...sourced(e), kind: "requirement", statement: "Both", manual: true }))).toBe("sourced_or_manual");
  });

  it("rejects a quote that is not in the source, an ambiguous quote, and mismatched offsets", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    expect(await codeOf(createItem(e.ctx, { ...sourced(e, "The dashboard refreshes hourly."), kind: "requirement", statement: "x" }))).toBe(
      "quote_not_found",
    );
    expect(await codeOf(createItem(e.ctx, { ...sourced(e, "Dana:"), kind: "requirement", statement: "x" }))).toBe("quote_ambiguous");
    const start = NOTES_TEXT.indexOf(QUOTE);
    expect(
      await codeOf(
        createItem(e.ctx, {
          engagementId: e.engagementId,
          kind: "requirement",
          statement: "x",
          spans: [{ sourceId: e.sourceId, start: start + 1, end: start + 1 + QUOTE.length, quote: QUOTE }],
        }),
      ),
    ).toBe("quote_mismatch");
    expect(
      await codeOf(
        createItem(e.ctx, { engagementId: e.engagementId, kind: "requirement", statement: "x", spans: [{ sourceId: e.sourceId, start: 10, end: 100_000 }] }),
      ),
    ).toBe("span_out_of_range");
    expect(await codeOf(createItem(e.ctx, { ...sourced(e, "   "), kind: "requirement", statement: "x" }))).toBe("quote_not_found");
  });

  it("resolves a unique quote to offsets verified against the source text", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const { itemId, contentHash, events } = await createItem(e.ctx, { ...sourced(e), kind: "requirement", statement: "Dashboard refreshes every 5 minutes" });
    const start = NOTES_TEXT.indexOf(QUOTE);
    const payload = events[0]!.payload as { spans: { start: number; end: number; source_id: string; source_sha256: string }[]; manual: unknown };
    expect(payload.spans).toEqual([{ source_id: e.sourceId, source_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), start, end: start + QUOTE.length }]);
    expect(NOTES_TEXT.slice(payload.spans[0]!.start, payload.spans[0]!.end)).toBe(QUOTE);
    expect(payload.manual).toBeNull();
    expect(contentHash).toBe(
      itemContentHash({
        engagement_id: e.engagementId,
        item_id: itemId,
        kind: "requirement",
        version: 1,
        statement: "Dashboard refreshes every 5 minutes",
        spans: payload.spans as never,
        manual: null,
      }),
    );
    // Offsets + matching quote is accepted too (the extraction flow's path).
    await expect(
      createItem(e.ctx, {
        engagementId: e.engagementId,
        kind: "constraint",
        statement: "Nightly invoice export",
        spans: [{ sourceId: e.sourceId, start: NOTES_TEXT.indexOf("Invoices"), end: NOTES_TEXT.indexOf("Invoices") + 8, quote: "Invoices" }],
        provenance: { via: "ai_candidate", candidate_id: "00000000-0000-4000-8000-000000000001", model: "test-model", prompt_version: "extract.v1", edited: false },
      }),
    ).resolves.toMatchObject({ shortId: "HALV-C1" });
  });

  it("a manual item records entered_by = the acting user and no spans", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const { itemId } = await createItem(e.ctx, { engagementId: e.engagementId, kind: "assumption", statement: "Carriers accept CSV", manual: true });
    const [row] = await withTenant(app.db, { orgId: e.orgId }, (tx) => tx.select().from(itemVersion).where(eq(itemVersion.itemId, itemId)));
    expect(row).toMatchObject({ version: 1, spans: [], manual: { entered_by: e.userId }, provenance: { via: "manual" } });
  });

  it("a revision that removes every span becomes manual; adding spans makes it sourced again", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const { itemId, events } = await createItem(e.ctx, { ...sourced(e), kind: "requirement", statement: "v1" });
    const span = (events[0]!.payload as { spans: { start: number; end: number }[] }).spans[0]!;
    const v2 = await reviseItem(e.ctx, {
      engagementId: e.engagementId,
      itemId,
      statement: "v2",
      reasonCode: "correction",
      removeSpans: [{ sourceId: e.sourceId, start: span.start, end: span.end }],
    });
    expect(v2.events[0]!.payload).toMatchObject({ version: 2, spans: [], manual: { entered_by: e.userId } });
    const v3 = await reviseItem(e.ctx, {
      engagementId: e.engagementId,
      itemId,
      statement: "v3",
      reasonCode: "new_information",
      addSpans: [{ sourceId: e.sourceId, quote: "Route changes need approval within 48h." }],
    });
    expect(v3.events[0]!.payload).toMatchObject({ version: 3, manual: null });
    expect(await codeOf(reviseItem(e.ctx, { engagementId: e.engagementId, itemId, statement: "v4", reasonCode: "other", removeSpans: [{ sourceId: e.sourceId, start: 0, end: 3 }] }))).toBe(
      "span_not_on_item",
    );
    expect(await codeOf(reviseItem(e.ctx, { engagementId: e.engagementId, itemId, statement: "v4", reasonCode: "other", expectedVersion: 2 }))).toBe("version_mismatch");
  });
});

describe("bitemporal fields (invariant 6)", () => {
  it("occurred_at comes from the source date, recorded_at from the clock; asOf filters on recorded_at", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const created = await createItem(e.ctx, { ...sourced(e), kind: "requirement", statement: "Refresh every 5 minutes" });
    const v1Event = created.events[0]!;
    expect(v1Event.occurredAt).toEqual(e.sourceOccurredAt);
    expect(v1Event.recordedAt.getTime()).toBeGreaterThan(e.sourceOccurredAt.getTime());

    const manualDate = new Date("2026-01-15T05:00:00.000Z");
    const manual = await createItem(e.ctx, { engagementId: e.engagementId, kind: "decision", statement: "Use CSV", manual: true, occurredAt: manualDate });
    expect(manual.events[0]!.occurredAt).toEqual(manualDate);
    const undated = await createItem(e.ctx, { engagementId: e.engagementId, kind: "decision", statement: "Undated", manual: true });
    expect(undated.events[0]!.occurredAt).toEqual(undated.events[0]!.recordedAt);

    const revised = await reviseItem(e.ctx, { engagementId: e.engagementId, itemId: created.itemId, statement: "Refresh every 2 minutes", reasonCode: "scope_change" });
    const v2Event = revised.events[0]!;
    expect(v2Event.occurredAt).toEqual(e.sourceOccurredAt); // carried span → same source date
    expect(v2Event.recordedAt.getTime()).toBeGreaterThan(v1Event.recordedAt.getTime());

    const events = await withTenant(app.db, { orgId: e.orgId }, (tx) => readEvents(tx, e.engagementId));
    const before = asOf(events, new Date(v1Event.recordedAt.getTime() - 1), "known");
    expect(before.items.find((i) => i.itemId === created.itemId)).toBeUndefined();
    const atV1 = asOf(events, v1Event.recordedAt, "known");
    expect(atV1.items.find((i) => i.itemId === created.itemId)).toMatchObject({ currentVersion: 1 });
    const betweenRevisions = asOf(events, new Date(v2Event.recordedAt.getTime() - 1), "known");
    expect(betweenRevisions.items.find((i) => i.itemId === created.itemId)?.current.statement).toBe("Refresh every 5 minutes");
    const now = asOf(events, v2Event.recordedAt, "known");
    expect(now.items.find((i) => i.itemId === created.itemId)).toMatchObject({ currentVersion: 2 });
    // The source date never moves an item into an earlier replay: the item is unknown before it was recorded.
    expect(asOf(events, e.sourceOccurredAt, "known").items).toEqual([]);
  });
});

describe("short ids", () => {
  it("are allocated per kind and stay stable; parallel creates get distinct ids", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const r1 = await createItem(e.ctx, { engagementId: e.engagementId, kind: "requirement", statement: "R one", manual: true });
    const p1 = await createItem(e.ctx, { engagementId: e.engagementId, kind: "problem", statement: "P one", manual: true });
    expect([r1.shortId, p1.shortId]).toEqual(["HALV-R1", "HALV-P1"]);
    const parallel = await Promise.all([
      createItem(e.ctx, { engagementId: e.engagementId, kind: "requirement", statement: "R two", manual: true }),
      createItem(e.ctx, { engagementId: e.engagementId, kind: "requirement", statement: "R three", manual: true }),
    ]);
    expect(parallel.map((r) => r.shortId).sort()).toEqual(["HALV-R2", "HALV-R3"]);
    await withdrawItem(e.ctx, { engagementId: e.engagementId, itemId: r1.itemId, reasonCode: "duplicate" });
    const r4 = await createItem(e.ctx, { engagementId: e.engagementId, kind: "requirement", statement: "R four", manual: true });
    expect(r4.shortId).toBe("HALV-R4");
  });
});

describe("dependency flagging (D-011, D-024)", () => {
  async function graph() {
    const e = await createLedgerEngagement(app, admin.db);
    const up = await createItem(e.ctx, { ...sourced(e), kind: "constraint", statement: "Refresh every 5 minutes" });
    const other = await createItem(e.ctx, { engagementId: e.engagementId, kind: "assumption", statement: "Carriers accept CSV", manual: true });
    const dep = await createItem(e.ctx, { engagementId: e.engagementId, kind: "requirement", statement: "Live dashboard", manual: true, dependsOn: [up.itemId] });
    return { e, up, other, dep };
  }

  it("revising, superseding or withdrawing the upstream flags the dependent; revise or clear_review clears", async () => {
    const { e, up, other, dep } = await graph();
    await reviseItem(e.ctx, { engagementId: e.engagementId, itemId: up.itemId, statement: "Refresh every 2 minutes", reasonCode: "scope_change" });
    let d = await itemState(e, dep.itemId);
    expect(d.needsReview).toBe(true);
    expect(d.reviewReasons).toMatchObject([{ upstreamItemId: up.itemId, cause: "revised" }]);

    await clearReview(e.ctx, { engagementId: e.engagementId, itemId: dep.itemId });
    expect((await itemState(e, dep.itemId)).needsReview).toBe(false);
    expect(await codeOf(clearReview(e.ctx, { engagementId: e.engagementId, itemId: dep.itemId }))).toBe("review_not_needed");

    await supersedeItem(e.ctx, { engagementId: e.engagementId, itemId: up.itemId, supersededByItemId: other.itemId, reasonCode: "kind_change" });
    d = await itemState(e, dep.itemId);
    expect(d.reviewReasons.map((r) => r.cause)).toEqual(["superseded"]);
    // Revising the dependent clears its flag.
    await reviseItem(e.ctx, { engagementId: e.engagementId, itemId: dep.itemId, statement: "Live dashboard (reviewed)", reasonCode: "correction" });
    expect((await itemState(e, dep.itemId)).needsReview).toBe(false);

    await addDependency(e.ctx, { engagementId: e.engagementId, itemId: dep.itemId, dependsOnItemId: other.itemId });
    await withdrawItem(e.ctx, { engagementId: e.engagementId, itemId: other.itemId, reasonCode: "out_of_scope" });
    expect((await itemState(e, dep.itemId)).reviewReasons.map((r) => r.cause)).toEqual(["withdrawn"]);
  });

  it("a client dispute of the upstream's current version flags the dependent", async () => {
    const { e, up, dep } = await graph();
    const { contactId } = await addContact(e.ctx, { engagementId: e.engagementId, name: "Ada Client", email: "ada@client.example" });
    const current = await itemState(e, up.itemId);
    const { requestId } = await requestConfirmation(e.ctx, { engagementId: e.engagementId, items: [{ itemId: up.itemId }], contactIds: [contactId] });
    const client = clientContext(e.ctx);
    await recordAuthorization(client, { engagementId: e.engagementId, requestId, contactId, decision: "granted", text: "I authorize.", textVersion: AUTHORIZATION_TEXT_VERSION, evidence: { ip: null, userAgent: null } });
    await recordClientResponses(client, {
      channel: "email_link",
      engagementId: e.engagementId,
      requestId,
      contactId,
      submissionId: "00000000-0000-4000-8000-0000000000aa",
      responses: [{ itemId: up.itemId, version: 1, contentHash: current.versions[0]!.contentHash, decision: "disputed", comment: "Too frequent." }],
      evidence: { ip: "192.0.2.1", userAgent: "test-agent" },
    });
    const d = await itemState(e, dep.itemId);
    expect(d.reviewReasons).toMatchObject([{ upstreamItemId: up.itemId, cause: "disputed" }]);
  });

  it("rejects cycles, self-edges, duplicates, non-decision/requirement dependents and inactive upstreams", async () => {
    const { e, up, other, dep } = await graph();
    const second = await createItem(e.ctx, { engagementId: e.engagementId, kind: "decision", statement: "Poll the API", manual: true, dependsOn: [dep.itemId] });
    expect(await codeOf(addDependency(e.ctx, { engagementId: e.engagementId, itemId: dep.itemId, dependsOnItemId: second.itemId }))).toBe("dependency_cycle");
    expect(await codeOf(addDependency(e.ctx, { engagementId: e.engagementId, itemId: dep.itemId, dependsOnItemId: dep.itemId }))).toBe("dependency_cycle");
    expect(await codeOf(addDependency(e.ctx, { engagementId: e.engagementId, itemId: dep.itemId, dependsOnItemId: up.itemId }))).toBe("dependency_exists");
    expect(await codeOf(addDependency(e.ctx, { engagementId: e.engagementId, itemId: up.itemId, dependsOnItemId: other.itemId }))).toBe(
      "dependency_kind_not_allowed",
    );
    expect(await codeOf(createItem(e.ctx, { engagementId: e.engagementId, kind: "problem", statement: "P", manual: true, dependsOn: [up.itemId] }))).toBe(
      "dependency_kind_not_allowed",
    );
    await withdrawItem(e.ctx, { engagementId: e.engagementId, itemId: other.itemId, reasonCode: "duplicate" });
    expect(await codeOf(addDependency(e.ctx, { engagementId: e.engagementId, itemId: dep.itemId, dependsOnItemId: other.itemId }))).toBe(
      "dependency_target_invalid",
    );
    await removeDependency(e.ctx, { engagementId: e.engagementId, itemId: dep.itemId, dependsOnItemId: up.itemId });
    expect(await codeOf(removeDependency(e.ctx, { engagementId: e.engagementId, itemId: dep.itemId, dependsOnItemId: up.itemId }))).toBe("dependency_not_found");
    expect((await itemState(e, dep.itemId)).dependsOn.size).toBe(0);
  });
});

describe("lifecycle commands", () => {
  it("reject changes to inactive items and invalid supersede targets", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const a = await createItem(e.ctx, { engagementId: e.engagementId, kind: "problem", statement: "A", manual: true });
    const b = await createItem(e.ctx, { engagementId: e.engagementId, kind: "problem", statement: "B", manual: true });
    expect(await codeOf(supersedeItem(e.ctx, { engagementId: e.engagementId, itemId: a.itemId, supersededByItemId: a.itemId, reasonCode: "duplicate" }))).toBe(
      "supersede_target_invalid",
    );
    await withdrawItem(e.ctx, { engagementId: e.engagementId, itemId: b.itemId, reasonCode: "entered_in_error", note: "Entered twice" });
    expect(await codeOf(supersedeItem(e.ctx, { engagementId: e.engagementId, itemId: a.itemId, supersededByItemId: b.itemId, reasonCode: "duplicate" }))).toBe(
      "supersede_target_invalid",
    );
    expect(await codeOf(reviseItem(e.ctx, { engagementId: e.engagementId, itemId: b.itemId, statement: "B2", reasonCode: "other" }))).toBe("item_not_active");
    expect(await codeOf(withdrawItem(e.ctx, { engagementId: e.engagementId, itemId: b.itemId, reasonCode: "other" }))).toBe("item_not_active");
    expect(await codeOf(withdrawItem(e.ctx, { engagementId: e.engagementId, itemId: "00000000-0000-4000-8000-000000000999", reasonCode: "other" }))).toBe(
      "item_not_found",
    );
  });
});

describe("humans gate the ledger (invariant 10)", () => {
  it("item events authored by a system or contact actor are rejected by the append path", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const payload = {
      item_id: "00000000-0000-4000-8000-000000000123",
      short_id: "HALV-R1",
      kind: "requirement" as const,
      version: 1 as const,
      statement: "Machine-made",
      spans: [],
      manual: { entered_by: e.userId },
      depends_on: [],
      provenance: { via: "manual" as const },
      content_hash: "b".repeat(64),
    };
    for (const actor of [{ type: "system" as const, id: null }, { type: "contact" as const, id: "00000000-0000-4000-8000-000000000456" }]) {
      const code = await codeOf(
        withTenant(app.db, { orgId: e.orgId }, (tx) => appendEvents(tx, e.engagementId, [{ type: "item_created", actor, payload }], { clock: e.ctx.clock })),
      );
      expect(code).toBe("invalid_event");
    }
  });
});
