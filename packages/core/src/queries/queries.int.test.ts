// Read helpers over the projection and operational tables.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { candidate, sourceContent, withTenant } from "@veradact/db";
import { adminTestDb, testDb } from "@veradact/db/testing";
import { recordAuthorization, recordClientResponses, requestConfirmation } from "../commands/confirmation";
import { addContact } from "../commands/contacts";
import { archiveEngagement } from "../commands/engagements";
import { addDependency, createItem, reviseItem, withdrawItem } from "../commands/items";
import { clientContext, createLedgerEngagement, NOTES_TEXT, tamper } from "../test-support/ledger";
import { getEngagementSummary, getItemDetail, getSourceDetail, listConfirmationRequests, listContacts, listEngagements, listItems, listSources } from "./index";
import { AUTHORIZATION_TEXT_VERSION } from "../confirmation/authorization-text";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

const QUOTE = "Invoices are exported nightly to the carrier portal.";

async function ledger() {
  const e = await createLedgerEngagement(app, admin.db);
  const candidateId = randomUUID();
  const start = NOTES_TEXT.indexOf(QUOTE);
  await withTenant(app.db, { orgId: e.orgId }, (tx) =>
    tx.insert(candidate).values({
      id: candidateId,
      orgId: e.orgId,
      engagementId: e.engagementId,
      sourceId: e.sourceId,
      extractionRunId: "00000000-0000-4000-8000-00000000e001",
      ordinal: 1,
      kind: "constraint",
      statement: "Invoices export nightly",
      quote: QUOTE,
      start,
      end: start + QUOTE.length,
      verification: "offset_corrected",
      status: "accepted",
      createdAt: new Date("2026-03-02T15:00:30.000Z"),
    }),
  );
  const constraint = await createItem(e.ctx, {
    engagementId: e.engagementId,
    kind: "constraint",
    statement: "Invoices export nightly",
    spans: [{ sourceId: e.sourceId, start, end: start + QUOTE.length, quote: QUOTE }],
    provenance: { via: "ai_candidate", candidate_id: candidateId, model: "test-model", prompt_version: "extract.v1", edited: false },
  });
  const assumption = await createItem(e.ctx, { engagementId: e.engagementId, kind: "assumption", statement: "Carriers accept CSV", manual: true });
  const requirement = await createItem(e.ctx, {
    engagementId: e.engagementId,
    kind: "requirement",
    statement: "Export runs at 02:00",
    manual: true,
    dependsOn: [constraint.itemId],
  });
  await addDependency(e.ctx, { engagementId: e.engagementId, itemId: requirement.itemId, dependsOnItemId: assumption.itemId });
  const problem = await createItem(e.ctx, { engagementId: e.engagementId, kind: "problem", statement: "Manual invoicing is slow", manual: true });
  await withdrawItem(e.ctx, { engagementId: e.engagementId, itemId: problem.itemId, reasonCode: "out_of_scope" });
  const { contactId } = await addContact(e.ctx, { engagementId: e.engagementId, name: "Ada Client", email: "ada@client.example", title: "Ops" });
  const request = await requestConfirmation(e.ctx, { engagementId: e.engagementId, items: [{ itemId: constraint.itemId }, { itemId: requirement.itemId }], contactIds: [contactId] });
  const client = clientContext(e.ctx);
  await recordAuthorization(client, { engagementId: e.engagementId, requestId: request.requestId, contactId, decision: "granted", text: "I authorize.", textVersion: AUTHORIZATION_TEXT_VERSION, evidence: { ip: null, userAgent: null } });
  await recordClientResponses(client, {
    channel: "email_link",
    engagementId: e.engagementId,
    requestId: request.requestId,
    contactId,
    submissionId: "00000000-0000-4000-8000-00000000b001",
    responses: [{ itemId: constraint.itemId, version: 1, contentHash: constraint.contentHash, decision: "disputed", comment: "It is weekly." }],
    evidence: { ip: null, userAgent: null },
  });
  await reviseItem(e.ctx, { engagementId: e.engagementId, itemId: constraint.itemId, statement: "Invoices export weekly", reasonCode: "client_dispute", note: "Client corrected cadence" });
  return { e, constraint, assumption, requirement, problem, contactId, request, candidateId };
}

describe("listItems", () => {
  it("lists current versions in ledger order with kind/status/lifecycle/needs-review filters", async () => {
    const { e, constraint, requirement, problem } = await ledger();
    await withTenant(app.db, { orgId: e.orgId }, async (tx) => {
      const all = await listItems(tx, e.engagementId);
      expect(all.map((i) => i.shortId)).toEqual(["HALV-P1", "HALV-C1", "HALV-A1", "HALV-R1"]);
      const c = all.find((i) => i.id === constraint.itemId)!;
      expect(c).toMatchObject({ currentVersion: 2, status: "pending", statement: "Invoices export weekly", manual: false, spanCount: 1 });
      expect((await listItems(tx, e.engagementId, { lifecycle: "active" })).map((i) => i.id)).not.toContain(problem.itemId);
      expect((await listItems(tx, e.engagementId, { kind: ["requirement", "problem"] })).map((i) => i.shortId)).toEqual(["HALV-P1", "HALV-R1"]);
      expect((await listItems(tx, e.engagementId, { needsReview: true })).map((i) => i.id)).toEqual([requirement.itemId]);
      expect(await listItems(tx, e.engagementId, { status: "confirmed" })).toEqual([]);
    });
  });
});

describe("getItemDetail", () => {
  it("returns versions with verified quotes, provenance, notes, responses, dependencies and dependents", async () => {
    const { e, constraint, requirement, assumption, candidateId } = await ledger();
    await withTenant(app.db, { orgId: e.orgId }, async (tx) => {
      const detail = (await getItemDetail(tx, e.engagementId, "HALV-C1"))!;
      expect(detail.id).toBe(constraint.itemId);
      expect(detail.versions).toHaveLength(2);
      const [v1, v2] = detail.versions;
      expect(v1!.spans[0]).toMatchObject({ quote: QUOTE, quoteState: "verified", sourceTitle: "Kickoff notes", sourceType: "human_notes", carried: false });
      expect(v1!.candidate).toEqual({ candidateId, extractionRunId: "00000000-0000-4000-8000-00000000e001", verification: "offset_corrected", model: "test-model", promptVersion: "extract.v1", edited: false });
      expect(v1!.status).toBe("disputed");
      expect(v1!.responses).toMatchObject([{ contactName: "Ada Client", response: "disputed", comment: "It is weekly." }]);
      expect(v2).toMatchObject({ version: 2, reasonCode: "client_dispute", note: "Client corrected cadence", status: "pending", responses: [] });
      expect(v2!.spans[0]).toMatchObject({ carried: true, quote: QUOTE });
      expect(detail.dependents.map((d) => d.id)).toEqual([requirement.itemId]);

      const req = (await getItemDetail(tx, e.engagementId, requirement.itemId))!;
      expect(req.dependencies.map((d) => d.shortId)).toEqual(["HALV-C1", "HALV-A1"]);
      expect(req.needsReview).toBe(true);
      expect(req.reviewReasons.map((r) => [r.upstreamShortId, r.cause])).toEqual([
        ["HALV-C1", "disputed"],
        ["HALV-C1", "revised"],
      ]);
      expect(req.versions[0]!.manual).toEqual({ enteredBy: e.userId, enteredByName: "Test User" });
      expect((await getItemDetail(tx, e.engagementId, assumption.itemId))!.dependents.map((d) => d.shortId)).toEqual(["HALV-R1"]);
      expect(await getItemDetail(tx, e.engagementId, "HALV-R99")).toBeNull();
    });
  });

  it("does not show a quote whose source text no longer matches its hash", async () => {
    const { e, constraint } = await ledger();
    await tamper(admin.db, sql`update source_content set text = text || ' tampered' where source_id = ${e.sourceId}`);
    await withTenant(app.db, { orgId: e.orgId }, async (tx) => {
      const detail = (await getItemDetail(tx, e.engagementId, constraint.itemId))!;
      expect(detail.versions[0]!.spans[0]).toMatchObject({ quote: null, quoteState: "unavailable" });
      const src = (await getSourceDetail(tx, e.engagementId, e.sourceId))!;
      expect(src.content?.integrity).toBe("mismatch");
    });
  });
});

describe("sources, contacts, requests, summary", () => {
  it("lists sources with titles and citations, contacts with authorization, requests with link status, and summary counts", async () => {
    const { e, constraint, requirement, contactId, request } = await ledger();
    await withTenant(app.db, { orgId: e.orgId }, async (tx) => {
      const sources = await listSources(tx, e.engagementId);
      expect(sources).toMatchObject([{ id: e.sourceId, title: "Kickoff notes", filename: "kickoff.md", sourceType: "human_notes", redactedAt: null }]);
      const detail = (await getSourceDetail(tx, e.engagementId, e.sourceId))!;
      expect(detail.content).toMatchObject({ text: NOTES_TEXT, integrity: "verified" });
      expect(detail.citations.map((c) => [c.shortId, c.version, c.current])).toEqual([
        ["HALV-C1", 1, false],
        ["HALV-C1", 2, true],
      ]);
      const [content] = await tx.select({ text: sourceContent.text }).from(sourceContent).where(eq(sourceContent.sourceId, e.sourceId));
      expect(content!.text.slice(detail.citations[0]!.start, detail.citations[0]!.end)).toBe(QUOTE);

      const contacts = await listContacts(tx, e.engagementId);
      expect(contacts).toMatchObject([{ id: contactId, name: "Ada Client", email: "ada@client.example", title: "Ops", erased: false, authorization: { decision: "granted", textVersion: AUTHORIZATION_TEXT_VERSION } }]);

      const requests = await listConfirmationRequests(tx, e.engagementId, { now: new Date("2026-03-03T00:00:00.000Z") });
      expect(requests).toHaveLength(1);
      expect(requests[0]!.id).toBe(request.requestId);
      expect(requests[0]!.items.map((i) => [i.itemId, i.version, i.changedSinceRequest])).toEqual([
        [constraint.itemId, 1, true],
        [requirement.itemId, 1, false],
      ]);
      expect(requests[0]!.contacts).toMatchObject([{ contactId, contactName: "Ada Client", linkStatus: "responded", responses: [{ itemId: constraint.itemId, response: "disputed" }] }]);
      const later = await listConfirmationRequests(tx, e.engagementId, { now: new Date("2026-04-30T00:00:00.000Z"), requestId: request.requestId });
      expect(later[0]!.expired).toBe(true);

      const summary = (await getEngagementSummary(tx, e.engagementId))!;
      expect(summary.engagement).toMatchObject({ id: e.engagementId, shortCode: "HALV", status: "active" });
      expect(summary.items).toMatchObject({ total: 4, active: 3, withdrawn: 1, superseded: 0, needsReview: 1, byStatus: { pending: 3, confirmed: 0, disputed: 0 } });
      expect(summary.items.byKind).toEqual({ problem: 0, constraint: 1, assumption: 1, decision: 0, requirement: 1 });
      expect(summary.sources).toEqual({ total: 1, redacted: 0 });
      expect(summary.contacts).toEqual({ total: 1, erased: 0 });
      expect(summary.requests).toEqual({ total: 1 });
      expect(summary.head?.seq).toBeGreaterThan(5);
    });
  });

  it("lists engagements, optionally by status", async () => {
    const { e } = await ledger();
    await archiveEngagement(e.ctx, { engagementId: e.engagementId });
    await withTenant(app.db, { orgId: e.orgId }, async (tx) => {
      expect((await listEngagements(tx)).map((r) => r.id)).toEqual([e.engagementId]);
      expect(await listEngagements(tx, { status: "active" })).toEqual([]);
      expect((await listEngagements(tx, { status: "archived" }))[0]).toMatchObject({ shortCode: "HALV", status: "archived" });
    });
  });
});
