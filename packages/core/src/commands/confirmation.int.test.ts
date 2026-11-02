// Client confirmation at the domain level: invariant 4 (confirmations bind to one item version),
// idempotent submissions, and the §8.4 validation rules.
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { auditLog, confirmationEvidence, confirmationLink, itemResponse, responseComment, withTenant } from "@veradact/db";
import { adminTestDb, testDb } from "@veradact/db/testing";
import { asOf, canonicalJson, hmacSha256Hex, sha256Hex } from "../domain";
import { DomainError } from "../errors";
import { getItemDetail, listConfirmationRequests } from "../queries";
import { loadState, readEventRows, readEvents } from "../store";
import { clientContext, createLedgerEngagement, type LedgerEngagement } from "../test-support/ledger";
import { recordAuthorization, recordClientResponses, requestConfirmation, revokeConfirmation, type RecordClientResponsesInput } from "./confirmation";
import { addContact } from "./contacts";
import { createItem, reviseItem, withdrawItem } from "./items";
import { eraseContact } from "./privacy";

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

let submissionSerial = 0;
function submissionId(): string {
  submissionSerial += 1;
  return `00000000-0000-4000-8000-${submissionSerial.toString(16).padStart(12, "0")}`;
}

const EVIDENCE = { ip: "192.0.2.10", userAgent: "Mozilla/5.0 (synthetic)" };
const AUTH_TEXT = "I authorize Quillfield Labs to record my confirmations for Synthetic engagement.";

/** Engagement + one sourced item + an authorized contact on a fresh request. */
async function scenario() {
  const e = await createLedgerEngagement(app, admin.db);
  const item = await createItem(e.ctx, {
    engagementId: e.engagementId,
    kind: "requirement",
    statement: "The dispatch dashboard refreshes every five minutes.",
    spans: [{ sourceId: e.sourceId, quote: "The dispatch dashboard must refresh every five minutes." }],
  });
  const { contactId } = await addContact(e.ctx, { engagementId: e.engagementId, name: "Ada Client", email: "Ada@Client.example", title: "Ops lead" });
  const request = await requestConfirmation(e.ctx, { engagementId: e.engagementId, items: [{ itemId: item.itemId, version: 1, contentHash: item.contentHash }], contactIds: [contactId] });
  const client = clientContext(e.ctx);
  await recordAuthorization(client, { engagementId: e.engagementId, requestId: request.requestId, contactId, decision: "granted", text: AUTH_TEXT, textVersion: "v1", evidence: EVIDENCE });
  const respond = (responses: RecordClientResponsesInput["responses"], overrides: Partial<RecordClientResponsesInput> = {}) =>
    recordClientResponses(client, {
      channel: "email_link",
      engagementId: e.engagementId,
      requestId: request.requestId,
      contactId,
      submissionId: submissionId(),
      responses,
      evidence: EVIDENCE,
      ...overrides,
    });
  return { e, item, contactId, request, client, respond };
}

async function state(e: LedgerEngagement) {
  return withTenant(app.db, { orgId: e.orgId }, (tx) => loadState(tx, e.engagementId));
}

describe("confirmations bind to one item version (invariant 4)", () => {
  it("a v1 confirmation stays in history after a revision, never counts for v2, and v1's hash is then rejected", async () => {
    const { e, item, request, respond, contactId } = await scenario();
    await respond([{ itemId: item.itemId, version: 1, contentHash: item.contentHash, decision: "confirmed" }]);
    expect((await state(e)).items.get(item.itemId)!.status).toBe("confirmed");

    const v2 = await reviseItem(e.ctx, { engagementId: e.engagementId, itemId: item.itemId, statement: "The dispatch dashboard refreshes every two minutes.", reasonCode: "scope_change" });
    const after = (await state(e)).items.get(item.itemId)!;
    expect(after).toMatchObject({ currentVersion: 2, status: "pending" });
    expect(v2.contentHash).not.toBe(item.contentHash);

    await withTenant(app.db, { orgId: e.orgId }, async (tx) => {
      const responses = await tx.select().from(itemResponse).where(eq(itemResponse.itemId, item.itemId));
      expect(responses).toMatchObject([{ version: 1, contentHash: item.contentHash, response: "confirmed", contactId, requestId: request.requestId }]);
      const detail = await getItemDetail(tx, e.engagementId, item.itemId);
      expect(detail!.versions.map((v) => [v.version, v.status, v.responses.length])).toEqual([
        [1, "confirmed", 1],
        [2, "pending", 0],
      ]);
      expect(detail!.versions[0]!.responses[0]).toMatchObject({ contactName: "Ada Client", contactErased: false });

      // Replay: the v1 confirmation is visible in history; the agreed view does not carry it over.
      const events = await readEvents(tx, e.engagementId);
      const known = asOf(events, events.at(-1)!.recordedAt, "known");
      const k = known.items.find((i) => i.itemId === item.itemId)!;
      expect(k.versions[0]!.status).toBe("confirmed");
      expect(k.current).toMatchObject({ version: 2, status: "pending" });
      const agreed = asOf(events, events.at(-1)!.recordedAt, "agreed");
      expect(agreed.items.map((i) => i.itemId)).not.toContain(item.itemId);
      expect(agreed.previouslyAgreed).toMatchObject([{ itemId: item.itemId, agreedVersion: 1, currentVersion: 2 }]);
    });

    // Responding with v1's version and hash after the revision is rejected.
    expect(await codeOf(respond([{ itemId: item.itemId, version: 1, contentHash: item.contentHash, decision: "confirmed" }]))).toBe("version_mismatch");
    // v2 is not part of the old request.
    expect(await codeOf(respond([{ itemId: item.itemId, version: 2, contentHash: v2.contentHash, decision: "confirmed" }]))).toBe("item_not_in_request");
    // A new request for v2 can be confirmed.
    const second = await requestConfirmation(e.ctx, { engagementId: e.engagementId, items: [{ itemId: item.itemId }], contactIds: [contactId] });
    await respond([{ itemId: item.itemId, version: 2, contentHash: v2.contentHash, decision: "confirmed" }], { requestId: second.requestId });
    expect((await state(e)).items.get(item.itemId)!.status).toBe("confirmed");
  });

  it("requesting a stale version is a version_mismatch; confirmed items cannot be requested", async () => {
    const { e, item, respond, contactId } = await scenario();
    expect(await codeOf(requestConfirmation(e.ctx, { engagementId: e.engagementId, items: [{ itemId: item.itemId, version: 7 }], contactIds: [contactId] }))).toBe(
      "version_mismatch",
    );
    await respond([{ itemId: item.itemId, version: 1, contentHash: item.contentHash, decision: "confirmed" }]);
    expect(await codeOf(requestConfirmation(e.ctx, { engagementId: e.engagementId, items: [{ itemId: item.itemId }], contactIds: [contactId] }))).toBe(
      "item_not_requestable",
    );
  });
});

describe("recordClientResponses", () => {
  it("writes one batch with evidence snapshots and dispute comments; commitments verify against the snapshot", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const a = await createItem(e.ctx, { engagementId: e.engagementId, kind: "requirement", statement: "A", manual: true });
    const b = await createItem(e.ctx, { engagementId: e.engagementId, kind: "decision", statement: "B", manual: true });
    const { contactId } = await addContact(e.ctx, { engagementId: e.engagementId, name: "Ada Client", email: "ada@client.example" });
    const request = await requestConfirmation(e.ctx, { engagementId: e.engagementId, items: [{ itemId: a.itemId }, { itemId: b.itemId }], contactIds: [contactId] });
    const client = clientContext(e.ctx);
    await recordAuthorization(client, { engagementId: e.engagementId, requestId: request.requestId, contactId, decision: "granted", text: AUTH_TEXT, textVersion: "v1", evidence: EVIDENCE });
    const sid = submissionId();
    const result = await recordClientResponses(client, {
      channel: "email_link",
      engagementId: e.engagementId,
      requestId: request.requestId,
      contactId,
      submissionId: sid,
      responses: [
        { itemId: a.itemId, version: 1, contentHash: a.contentHash, decision: "confirmed", comment: "ignored for confirmations" },
        { itemId: b.itemId, version: 1, contentHash: b.contentHash, decision: "disputed", comment: "  We never agreed to B.  " },
      ],
      evidence: EVIDENCE,
    });
    expect(result.duplicate).toBe(false);
    expect(result.events.map((ev) => ev.type)).toEqual(["item_confirmed", "item_disputed"]);
    expect(new Set(result.events.map((ev) => ev.recordedAt.getTime())).size).toBe(1);
    expect(result.head).toEqual({ seq: result.events[1]!.seq, hash: result.events[1]!.hash });
    expect(JSON.stringify(result.events.map((ev) => ev.payload))).not.toMatch(/never agreed|Ada|192\.0\.2|Mozilla/);

    await withTenant(app.db, { orgId: e.orgId }, async (tx) => {
      const evidence = await tx.select().from(confirmationEvidence).where(eq(confirmationEvidence.contactId, contactId));
      // authorization + two responses
      expect(evidence).toHaveLength(3);
      const [pii] = await tx.execute<{ hmac_key: Buffer }>(sql`select hmac_key from contact_pii where contact_id = ${contactId}`);
      const key = pii!.hmac_key;
      for (const [i, eventId] of result.eventIds.entries()) {
        const snap = evidence.find((r) => r.eventId === eventId)!;
        expect(snap).toMatchObject({ name: "Ada Client", email: "ada@client.example", ip: EVIDENCE.ip, userAgent: EVIDENCE.userAgent });
        const expected = hmacSha256Hex(key, canonicalJson({ name: snap.name, email: snap.email, ip: snap.ip, user_agent: snap.userAgent }));
        expect((result.events[i]!.payload as { evidence_commitment: string }).evidence_commitment).toBe(expected);
      }
      const comments = await tx.select().from(responseComment).where(eq(responseComment.contactId, contactId));
      expect(comments).toEqual([{ eventId: result.eventIds[1], orgId: e.orgId, contactId, comment: "We never agreed to B." }]);
      expect((result.events[1]!.payload as { comment_commitment: string }).comment_commitment).toBe(hmacSha256Hex(key, "We never agreed to B."));
      const authEvent = (await readEventRows(tx, e.engagementId)).find((r) => r.event.type === "authorization_granted")!;
      expect((authEvent.event.payload as { text_sha256: string; text: string }).text_sha256).toBe(sha256Hex(AUTH_TEXT));
    });
    const s = await state(e);
    expect(s.items.get(a.itemId)!.status).toBe("confirmed");
    expect(s.items.get(b.itemId)!.status).toBe("disputed");
  });

  it("is idempotent per submission id: the same submission twice is a no-op", async () => {
    const { e, item, respond } = await scenario();
    const sid = submissionId();
    const responses = [{ itemId: item.itemId, version: 1, contentHash: item.contentHash, decision: "confirmed" as const }];
    const first = await respond(responses, { submissionId: sid });
    const second = await respond(responses, { submissionId: sid });
    expect(first.duplicate).toBe(false);
    expect(second).toMatchObject({ duplicate: true, events: [], eventIds: [] });
    expect(second.head).toEqual(first.head);
    const events = await withTenant(app.db, { orgId: e.orgId }, (tx) => readEvents(tx, e.engagementId));
    expect(events.filter((ev) => ev.type === "item_confirmed")).toHaveLength(1);
    // Also when the duplicate arrives concurrently.
    const sid2 = submissionId();
    const [x, y] = await Promise.all([respond(responses, { submissionId: sid2 }), respond(responses, { submissionId: sid2 })]);
    expect([x.duplicate, y.duplicate].sort()).toEqual([false, true]);
  });

  it("a contact may change their response; the latest per contact counts (D-029)", async () => {
    const { e, item, respond } = await scenario();
    await respond([{ itemId: item.itemId, version: 1, contentHash: item.contentHash, decision: "disputed", comment: "Not quite." }]);
    expect((await state(e)).items.get(item.itemId)!.status).toBe("disputed");
    await respond([{ itemId: item.itemId, version: 1, contentHash: item.contentHash, decision: "confirmed" }]);
    expect((await state(e)).items.get(item.itemId)!.status).toBe("confirmed");
  });

  it("rejects responses without authorization, after revocation or expiry, for inactive items, and malformed submissions", async () => {
    const { e, item, request, respond, client, contactId } = await scenario();
    const r = [{ itemId: item.itemId, version: 1, contentHash: item.contentHash, decision: "confirmed" as const }];
    expect(await codeOf(respond([{ ...r[0]!, decision: "disputed" }]))).toBe("comment_required");
    expect(await codeOf(respond([]))).toBe("empty_submission");
    expect(await codeOf(respond([r[0]!, r[0]!]))).toBe("duplicate_item_response");
    expect(await codeOf(respond([{ ...r[0]!, contentHash: "c".repeat(64) }]))).toBe("item_not_in_request");

    // Declined authorization (latest wins).
    await recordAuthorization(client, { engagementId: e.engagementId, requestId: request.requestId, contactId, decision: "declined", text: AUTH_TEXT, textVersion: "v1", evidence: EVIDENCE });
    expect(await codeOf(respond(r))).toBe("not_authorized");
    await recordAuthorization(client, { engagementId: e.engagementId, requestId: request.requestId, contactId, decision: "granted", text: AUTH_TEXT, textVersion: "v1", evidence: EVIDENCE });

    // A second contact who never authorized.
    const { contactId: other } = await addContact(e.ctx, { engagementId: e.engagementId, name: "Bo Client", email: "bo@client.example" });
    expect(await codeOf(respond(r, { contactId: other }))).toBe("not_authorized");
    expect(await codeOf(recordAuthorization(client, { engagementId: e.engagementId, requestId: request.requestId, contactId: other, decision: "granted", text: AUTH_TEXT, textVersion: "v1", evidence: EVIDENCE }))).toBe(
      "contact_not_in_request",
    );

    // Withdrawn item.
    const extra = await createItem(e.ctx, { engagementId: e.engagementId, kind: "problem", statement: "P", manual: true });
    const req2 = await requestConfirmation(e.ctx, { engagementId: e.engagementId, items: [{ itemId: extra.itemId }], contactIds: [contactId] });
    await withdrawItem(e.ctx, { engagementId: e.engagementId, itemId: extra.itemId, reasonCode: "out_of_scope" });
    expect(await codeOf(respond([{ itemId: extra.itemId, version: 1, contentHash: extra.contentHash, decision: "confirmed" }], { requestId: req2.requestId }))).toBe(
      "item_not_active",
    );

    // Revoked for this contact.
    await revokeConfirmation(e.ctx, { engagementId: e.engagementId, requestId: request.requestId, contactId });
    expect(await codeOf(respond(r))).toBe("request_revoked");
    expect(await codeOf(revokeConfirmation(e.ctx, { engagementId: e.engagementId, requestId: request.requestId, contactId }))).toBe("request_revoked");
  });

  it("rejects responses on an expired request", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const item = await createItem(e.ctx, { engagementId: e.engagementId, kind: "requirement", statement: "Expiring", manual: true });
    const { contactId } = await addContact(e.ctx, { engagementId: e.engagementId, name: "Ada Client", email: "ada@client.example" });
    // The stepping clock advances 1 s per read: request at t+1 s expiring at t+3 s, authorization
    // at t+2 s, two skipped ticks, responses at t+5 s.
    const request = await requestConfirmation(e.ctx, {
      engagementId: e.engagementId,
      items: [{ itemId: item.itemId }],
      contactIds: [contactId],
      expiresAt: new Date(e.ctx.clock().getTime() + 3_000),
    });
    const client = clientContext(e.ctx);
    await recordAuthorization(client, { engagementId: e.engagementId, requestId: request.requestId, contactId, decision: "granted", text: AUTH_TEXT, textVersion: "v1", evidence: EVIDENCE });
    e.ctx.clock();
    e.ctx.clock();
    const code = await codeOf(
      recordClientResponses(client, {
        channel: "email_link",
        engagementId: e.engagementId,
        requestId: request.requestId,
        contactId,
        submissionId: submissionId(),
        responses: [{ itemId: item.itemId, version: 1, contentHash: item.contentHash, decision: "confirmed" }],
        evidence: EVIDENCE,
      }),
    );
    expect(code).toBe("request_expired");
    expect(await codeOf(requestConfirmation(e.ctx, { engagementId: e.engagementId, items: [{ itemId: item.itemId }], contactIds: [contactId], expiresAt: new Date("2020-01-01T00:00:00.000Z") }))).toBe(
      "invalid_expiry",
    );
  });
});

describe("requestConfirmation / revokeConfirmation", () => {
  it("creates one link per contact with sent_to_email and expiry, audits, and revokes all links", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const item = await createItem(e.ctx, { engagementId: e.engagementId, kind: "requirement", statement: "R", manual: true });
    const c1 = await addContact(e.ctx, { engagementId: e.engagementId, name: "Ada Client", email: "ada@client.example" });
    const c2 = await addContact(e.ctx, { engagementId: e.engagementId, name: "Bo Client", email: "bo@client.example" });
    const { requestId, links, events } = await requestConfirmation(e.ctx, { engagementId: e.engagementId, items: [{ itemId: item.itemId }], contactIds: [c1.contactId, c2.contactId] });
    const recordedAt = events[0]!.recordedAt;
    const expiresAt = new Date(recordedAt.getTime() + 14 * 86_400_000);
    expect(links.map((l) => l.expiresAt)).toEqual([expiresAt, expiresAt]);
    expect(events[0]!.payload).toMatchObject({ request_id: requestId, contact_ids: [c1.contactId, c2.contactId], expires_at: expiresAt.toISOString(), channel: "email_link" });

    await withTenant(app.db, { orgId: e.orgId }, async (tx) => {
      const rows = await tx.select().from(confirmationLink).where(eq(confirmationLink.requestId, requestId));
      expect(rows.map((r) => r.sentToEmail).sort()).toEqual(["ada@client.example", "bo@client.example"]);
      expect(rows.every((r) => r.expiresAt.getTime() === expiresAt.getTime() && r.revokedAt === null)).toBe(true);
      expect(await tx.select().from(auditLog).where(and(eq(auditLog.targetId, requestId), eq(auditLog.action, "confirmation.request")))).toHaveLength(1);
      const [listed] = await listConfirmationRequests(tx, e.engagementId, { now: recordedAt });
      expect(listed!.items).toMatchObject([{ itemId: item.itemId, version: 1, changedSinceRequest: false }]);
      expect(listed!.contacts.map((c) => c.linkStatus)).toEqual(["not_sent", "not_sent"]);
    });

    const revoked = await revokeConfirmation(e.ctx, { engagementId: e.engagementId, requestId });
    await withTenant(app.db, { orgId: e.orgId }, async (tx) => {
      const rows = await tx.select().from(confirmationLink).where(eq(confirmationLink.requestId, requestId));
      expect(rows.every((r) => r.revokedAt?.getTime() === revoked.events[0]!.recordedAt.getTime())).toBe(true);
      expect(await tx.select().from(auditLog).where(and(eq(auditLog.targetId, requestId), eq(auditLog.action, "confirmation.revoke")))).toHaveLength(1);
      const [listed] = await listConfirmationRequests(tx, e.engagementId, { now: recordedAt });
      expect(listed!.contacts.map((c) => c.linkStatus)).toEqual(["revoked", "revoked"]);
    });
    expect(await codeOf(revokeConfirmation(e.ctx, { engagementId: e.engagementId, requestId }))).toBe("request_revoked");
  });

  it("rejects contacts from another engagement and erased contacts", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const other = await createLedgerEngagement(app, admin.db);
    const item = await createItem(e.ctx, { engagementId: e.engagementId, kind: "requirement", statement: "R", manual: true });
    const foreign = await addContact(other.ctx, { engagementId: other.engagementId, name: "Cy Client", email: "cy@client.example" });
    expect(await codeOf(requestConfirmation(e.ctx, { engagementId: e.engagementId, items: [{ itemId: item.itemId }], contactIds: [foreign.contactId] }))).toBe(
      "contact_not_found",
    );
    const local = await addContact(e.ctx, { engagementId: e.engagementId, name: "Di Client", email: "di@client.example" });
    await eraseContact(e.ctx, { engagementId: e.engagementId, contactId: local.contactId });
    expect(await codeOf(requestConfirmation(e.ctx, { engagementId: e.engagementId, items: [{ itemId: item.itemId }], contactIds: [local.contactId] }))).toBe(
      "contact_erased",
    );
  });
});
