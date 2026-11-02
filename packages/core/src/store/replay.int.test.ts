// Phase 4 acceptance: "replay at a past date matches the projection". An engagement history is
// built through the real commands with a stepping fake clock; the live projection tables are dumped
// at several points T_k while appending continues. Afterwards, for every T_k, the projection rows
// computed purely from `asOf(full log, T_k, 'known').state` must equal the dump taken at T_k, and
// `diff(T_k, T_k+1)` must list exactly the changes made between the two captures.
import { afterAll, describe, expect, it } from "vitest";
import { withTenant } from "@veradact/db";
import { adminTestDb, testDb } from "@veradact/db/testing";
import { recordAuthorization, recordClientResponses, requestConfirmation, revokeConfirmation } from "../commands/confirmation";
import { addContact } from "../commands/contacts";
import { addDependency, createItem, reviseItem, supersedeItem, withdrawItem } from "../commands/items";
import { eraseContact } from "../commands/privacy";
import { redactSource } from "../commands/sources";
import { asOf, diff, fold, projectRows, type ProjectionRows } from "../domain";
import { clientContext, createLedgerEngagement, uuid, type LedgerEngagement } from "../test-support/ledger";
import { dumpProjections, readEngagementHead, readEvents, verifyEngagementChain } from "./index";
import { AUTHORIZATION_TEXT_VERSION } from "../confirmation/authorization-text";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

interface Capture {
  at: Date;
  rows: ProjectionRows;
  head: { seq: number; hash: string };
}

/** Reads the clock (strictly after every event so far, before every later one) and dumps the live tables. */
async function capture(e: LedgerEngagement): Promise<Capture> {
  const at = e.ctx.clock();
  return withTenant(app.db, { orgId: e.orgId }, async (tx) => {
    const head = await readEngagementHead(tx, e.engagementId);
    return { at, rows: await dumpProjections(tx, e.engagementId), head: { seq: head!.seq, hash: head!.hash } };
  });
}

const EVIDENCE = { ip: "192.0.2.10", userAgent: "synthetic-agent" };

describe("replay matches the projection (Phase 4 acceptance)", () => {
  it("projectRows(asOf(T_k, 'known').state) equals the live dump taken at T_k; diff lists the changes between captures", async () => {
    const e = await createLedgerEngagement(app, admin.db, new Date("2026-03-02T15:00:00.000Z"));
    const { engagementId } = e;
    const client = clientContext(e.ctx);
    const sourced = (quote: string) => [{ sourceId: e.sourceId, quote }];

    // ---- Up to T1: items, dependencies, contacts, a request and authorizations.
    const c1 = await createItem(e.ctx, {
      engagementId,
      kind: "constraint",
      statement: "Invoices are exported nightly to the carrier portal.",
      spans: sourced("Invoices are exported nightly to the carrier portal."),
    });
    const a1 = await createItem(e.ctx, { engagementId, kind: "assumption", statement: "Carriers accept CSV uploads.", spans: sourced("We assume carriers accept CSV uploads.") });
    const d1 = await createItem(e.ctx, {
      engagementId,
      kind: "decision",
      statement: "Staff sign in through the existing SSO provider.",
      spans: sourced("Use the existing SSO provider for staff logins."),
      dependsOn: [a1.itemId],
    });
    const r1 = await createItem(e.ctx, {
      engagementId,
      kind: "requirement",
      statement: "The dispatch dashboard refreshes every five minutes.",
      spans: sourced("The dispatch dashboard must refresh every five minutes."),
    });
    await addDependency(e.ctx, { engagementId, itemId: r1.itemId, dependsOnItemId: c1.itemId });
    const ada = (await addContact(e.ctx, { engagementId, name: "Ada Client", email: "ada@client.example" })).contactId;
    const ben = (await addContact(e.ctx, { engagementId, name: "Ben Client", email: "ben@client.example" })).contactId;
    const req1 = (
      await requestConfirmation(e.ctx, { engagementId, items: [c1, a1, d1, r1].map((i) => ({ itemId: i.itemId })), contactIds: [ada, ben] })
    ).requestId;
    for (const contactId of [ada, ben]) {
      await recordAuthorization(client, { engagementId, requestId: req1, contactId, decision: "granted", text: "I authorize.", textVersion: AUTHORIZATION_TEXT_VERSION, evidence: EVIDENCE });
    }
    const respond = (requestId: string, contactId: string, responses: { item: { itemId: string; version: number; contentHash: string }; decision: "confirmed" | "disputed" }[]) =>
      recordClientResponses(client, {
        channel: "email_link",
        engagementId,
        requestId,
        contactId,
        submissionId: uuid(),
        responses: responses.map((r) => ({
          itemId: r.item.itemId,
          version: r.item.version,
          contentHash: r.item.contentHash,
          decision: r.decision,
          comment: r.decision === "disputed" ? "Not what we discussed." : null,
        })),
        evidence: EVIDENCE,
      });
    const t1 = await capture(e);

    // ---- (T1, T2]: confirmations, a dispute (flags d1), a new manual item with a dependency.
    await respond(req1, ada, [
      { item: r1, decision: "confirmed" },
      { item: d1, decision: "confirmed" },
      { item: a1, decision: "disputed" },
    ]);
    await respond(req1, ben, [
      { item: r1, decision: "confirmed" },
      { item: c1, decision: "confirmed" },
    ]);
    const r2 = await createItem(e.ctx, { engagementId, kind: "requirement", statement: "Route changes are approved within 48 hours.", manual: true });
    await addDependency(e.ctx, { engagementId, itemId: r2.itemId, dependsOnItemId: a1.itemId });
    const t2 = await capture(e);

    // ---- (T2, T3]: revisions (a confirmed item back to pending), a supersession, a withdrawal,
    // and responses to the new versions. d1 stays flagged and confirmed, so it does not change.
    const a1v2 = await reviseItem(e.ctx, { engagementId, itemId: a1.itemId, statement: "Carriers accept CSV or XLSX uploads.", reasonCode: "client_dispute" });
    const r1v2 = await reviseItem(e.ctx, { engagementId, itemId: r1.itemId, statement: "The dispatch dashboard refreshes every two minutes.", reasonCode: "scope_change" });
    const c2 = await createItem(e.ctx, {
      engagementId,
      kind: "constraint",
      statement: "Invoices reach the carrier portal by 02:00 every night.",
      spans: sourced("Invoices are exported nightly to the carrier portal."),
    });
    await supersedeItem(e.ctx, { engagementId, itemId: c1.itemId, supersededByItemId: c2.itemId, reasonCode: "correction" });
    await withdrawItem(e.ctx, { engagementId, itemId: r2.itemId, reasonCode: "out_of_scope" });
    const req2 = (await requestConfirmation(e.ctx, { engagementId, items: [a1v2, r1v2, c2].map((i) => ({ itemId: i.itemId })), contactIds: [ada] })).requestId;
    await respond(req2, ada, [
      { item: a1v2, decision: "confirmed" },
      { item: r1v2, decision: "disputed" },
    ]);
    const t3 = await capture(e);

    // ---- After T3: everything here must stay invisible to the earlier replays.
    await respond(req1, ben, [{ item: d1, decision: "confirmed" }]);
    await revokeConfirmation(e.ctx, { engagementId, requestId: req2, contactId: ada });
    await reviseItem(e.ctx, { engagementId, itemId: d1.itemId, statement: "Staff and dispatchers sign in through the existing SSO provider.", reasonCode: "new_information" });
    await redactSource(e.ctx, { engagementId, sourceId: e.sourceId, reasonCode: "user_request" });
    await eraseContact(e.ctx, { engagementId, contactId: ben });
    await withdrawItem(e.ctx, { engagementId, itemId: a1.itemId, reasonCode: "duplicate" });
    const final = await capture(e);

    const events = await withTenant(app.db, { orgId: e.orgId }, (tx) => readEvents(tx, engagementId));
    expect(events.at(-1)!.seq).toBe(final.head.seq);
    expect((await withTenant(app.db, { orgId: e.orgId }, (tx) => verifyEngagementChain(tx, engagementId))).ok).toBe(true);

    // The captures really differ (otherwise the comparison below proves nothing).
    const captures = [t1, t2, t3, final];
    for (let i = 1; i < captures.length; i++) expect(captures[i]!.rows).not.toEqual(captures[i - 1]!.rows);
    expect(final.rows.source[0]!.redactedAt).not.toBeNull();

    // Replay at each T_k over the FULL log equals what the live tables held at T_k.
    for (const c of captures) {
      const known = asOf(events, c.at, "known");
      expect(projectRows(known.state)).toEqual(c.rows);
      expect(known.head).toMatchObject({ seq: c.head.seq, hash: c.head.hash });
    }
    expect(projectRows(fold(events))).toEqual(final.rows);
    // Between two captures (here: just before T2's first event) the replay still shows T1.
    const firstAfterT1 = events.find((ev) => ev.recordedAt.getTime() > t1.at.getTime())!;
    expect(projectRows(asOf(events, new Date(firstAfterT1.recordedAt.getTime() - 1), "known").state)).toEqual(t1.rows);

    // Statuses as of each point (spot checks against the projection semantics).
    const statusAt = (c: Capture, itemId: string) => c.rows.item.find((r) => r.id === itemId);
    expect(statusAt(t1, r1.itemId)).toMatchObject({ status: "pending", currentVersion: 1 });
    expect(statusAt(t2, r1.itemId)).toMatchObject({ status: "confirmed", currentVersion: 1 });
    expect(statusAt(t3, r1.itemId)).toMatchObject({ status: "disputed", currentVersion: 2, needsReview: true });
    expect(statusAt(t2, d1.itemId)).toMatchObject({ status: "confirmed", needsReview: true });
    expect(statusAt(t3, c1.itemId)).toMatchObject({ lifecycle: "superseded", supersededBy: c2.itemId });
    expect(statusAt(t2, r2.itemId)).toMatchObject({ lifecycle: "active" });
    expect(statusAt(t3, r2.itemId)).toMatchObject({ lifecycle: "withdrawn" });
    expect(t1.rows.item.find((r) => r.id === r2.itemId)).toBeUndefined();

    // The agreed view follows the same cut: r1 agreed at T2, only "previously agreed" at T3 (D-010).
    expect(asOf(events, t1.at, "agreed").items).toEqual([]);
    expect(asOf(events, t2.at, "agreed").items.map((i) => i.itemId)).toEqual([c1.itemId, d1.itemId, r1.itemId]);
    const agreedT3 = asOf(events, t3.at, "agreed");
    expect(agreedT3.items.map((i) => i.itemId)).toEqual([a1.itemId, d1.itemId]);
    expect(agreedT3.previouslyAgreed.map((i) => [i.itemId, i.agreedVersion, i.currentVersion])).toEqual([[r1.itemId, 1, 2]]);

    // diff(T1, T2): exactly what happened between the first two captures.
    const d12 = diff(events, t1.at, t2.at);
    expect(d12.fromHead.seq).toBe(t1.head.seq);
    expect(d12.toHead.seq).toBe(t2.head.seq);
    expect(d12.added.map((i) => i.itemId)).toEqual([r2.itemId]);
    expect(d12.revised).toEqual([]);
    expect(d12.confirmed.map((r) => [r.itemId, r.contactId, r.version])).toEqual([
      [r1.itemId, ada, 1],
      [d1.itemId, ada, 1],
      [r1.itemId, ben, 1],
      [c1.itemId, ben, 1],
    ]);
    expect(d12.disputed.map((r) => [r.itemId, r.contactId, r.version])).toEqual([[a1.itemId, ada, 1]]);
    expect(d12.superseded).toEqual([]);
    expect(d12.withdrawn).toEqual([]);
    expect(d12.changes.map((c) => c.itemId).sort()).toEqual([c1, a1, d1, r1, r2].map((i) => i.itemId).sort());

    // diff(T2, T3).
    const d23 = diff(events, t2.at, t3.at);
    expect(d23.added.map((i) => i.itemId)).toEqual([c2.itemId]);
    expect(d23.revised.map((r) => [r.itemId, r.fromVersion, r.toVersion, r.fromStatement, r.toStatement])).toEqual([
      [a1.itemId, 1, 2, "Carriers accept CSV uploads.", "Carriers accept CSV or XLSX uploads."],
      [r1.itemId, 1, 2, "The dispatch dashboard refreshes every five minutes.", "The dispatch dashboard refreshes every two minutes."],
    ]);
    expect(d23.confirmed.map((r) => [r.itemId, r.contactId, r.version])).toEqual([[a1.itemId, ada, 2]]);
    expect(d23.disputed.map((r) => [r.itemId, r.contactId, r.version])).toEqual([[r1.itemId, ada, 2]]);
    expect(d23.superseded.map((s) => [s.itemId, s.supersededBy, s.reasonCode])).toEqual([[c1.itemId, c2.itemId, "correction"]]);
    expect(d23.withdrawn.map((w) => [w.itemId, w.reasonCode])).toEqual([[r2.itemId, "out_of_scope"]]);
    expect(d23.changes.map((c) => c.itemId).sort()).toEqual([c1, c2, a1, r1, r2].map((i) => i.itemId).sort());

    // diff(T3, final) sees only the post-T3 activity; an empty window has no changes.
    const d3f = diff(events, t3.at, final.at);
    expect(d3f.added).toEqual([]);
    expect(d3f.revised.map((r) => r.itemId)).toEqual([d1.itemId]);
    expect(d3f.confirmed.map((r) => [r.itemId, r.contactId, r.contactErased])).toEqual([[d1.itemId, ben, true]]);
    expect(d3f.withdrawn.map((w) => w.itemId)).toEqual([a1.itemId]);
    const empty = diff(events, t2.at, t2.at);
    expect([empty.added, empty.revised, empty.confirmed, empty.disputed, empty.superseded, empty.withdrawn, empty.changes].every((l) => l.length === 0)).toBe(true);
  }, 60_000);
});
