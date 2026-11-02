// Erasure (ARCHITECTURE §6) and invariant 8 (no PII or source text in the log).
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { auditLog, clientContact, confirmationEvidence, confirmationLink, contactPii, event, responseComment, withTenant } from "@veradact/db";
import { adminTestDb, testDb } from "@veradact/db/testing";
import { DomainError } from "../errors";
import { getItemDetail, listContacts } from "../queries";
import { dumpProjections, loadState, readEvents, rebuildProjections, verifyEngagementChain } from "../store";
import { clientContext, createLedgerEngagement, NOTES_TEXT } from "../test-support/ledger";
import { recordAuthorization, recordClientResponses, requestConfirmation } from "./confirmation";
import { addContact } from "./contacts";
import { createItem, reviseItem } from "./items";
import { eraseContact } from "./privacy";
import { redactSource } from "./sources";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

const EVIDENCE = { ip: "198.51.100.7", userAgent: "SyntheticBrowser/1.0" };
const COMMENT = "We said hourly, not every five minutes.";

/** A full flow: sourced item, contact, request, authorization, a dispute with a comment, a revision note. */
async function flow() {
  const e = await createLedgerEngagement(app, admin.db);
  const item = await createItem(e.ctx, {
    engagementId: e.engagementId,
    kind: "requirement",
    statement: "Dashboard refreshes every five minutes",
    spans: [{ sourceId: e.sourceId, quote: "The dispatch dashboard must refresh every five minutes." }],
  });
  const { contactId } = await addContact(e.ctx, { engagementId: e.engagementId, name: "Ada Lovelace-Client", email: "ada.private@client.example", title: "COO" });
  const { requestId } = await requestConfirmation(e.ctx, { engagementId: e.engagementId, items: [{ itemId: item.itemId }], contactIds: [contactId] });
  const client = clientContext(e.ctx);
  await recordAuthorization(client, { engagementId: e.engagementId, requestId, contactId, decision: "granted", text: "I authorize Quillfield Labs.", textVersion: "v1", evidence: EVIDENCE });
  await recordClientResponses(client, {
    channel: "email_link",
    engagementId: e.engagementId,
    requestId,
    contactId,
    submissionId: "00000000-0000-4000-8000-00000000f00d",
    responses: [{ itemId: item.itemId, version: 1, contentHash: item.contentHash, decision: "disputed", comment: COMMENT }],
    evidence: EVIDENCE,
  });
  await reviseItem(e.ctx, { engagementId: e.engagementId, itemId: item.itemId, statement: "Dashboard refreshes hourly", reasonCode: "client_dispute", note: "Per Ada's call on Tuesday" });
  return { e, item, contactId, requestId };
}

describe("no PII or source text in the log (invariant 8)", () => {
  it("event payloads carry ids, enums, hashes and commitments only", async () => {
    const { e } = await flow();
    const events = await withTenant(app.db, { orgId: e.orgId }, (tx) => readEvents(tx, e.engagementId));
    const log = JSON.stringify(events.map((ev) => ev.payload));
    const forbidden = [
      "Ada Lovelace-Client",
      "ada.private@client.example",
      "COO",
      EVIDENCE.ip,
      EVIDENCE.userAgent,
      COMMENT,
      "Per Ada's call",
      "Kickoff notes",
      "kickoff.md",
      "The dispatch dashboard must refresh every five minutes.",
      ...NOTES_TEXT.split("\n").filter((line) => line.length > 0),
    ];
    for (const value of forbidden) expect(log).not.toContain(value);
  });
});

describe("eraseContact", () => {
  it("deletes PII, evidence and comments, revokes links, appends contact_erased; the chain verifies and projections rebuild equal", async () => {
    const { e, item, contactId } = await flow();
    const before = await withTenant(app.db, { orgId: e.orgId }, (tx) => readEvents(tx, e.engagementId));
    const { events } = await eraseContact(e.ctx, { engagementId: e.engagementId, contactId });
    expect(events[0]).toMatchObject({ type: "contact_erased", payload: { contact_id: contactId }, actor: { type: "user", id: e.userId } });

    await withTenant(app.db, { orgId: e.orgId }, async (tx) => {
      expect(await tx.select().from(contactPii).where(eq(contactPii.contactId, contactId))).toEqual([]);
      expect(await tx.select().from(confirmationEvidence).where(eq(confirmationEvidence.contactId, contactId))).toEqual([]);
      expect(await tx.select().from(responseComment).where(eq(responseComment.contactId, contactId))).toEqual([]);
      const links = await tx.select().from(confirmationLink).where(eq(confirmationLink.contactId, contactId));
      expect(links.length).toBeGreaterThan(0);
      expect(links.every((l) => l.sentToEmail === null && l.revokedAt !== null)).toBe(true);
      const [contact] = await tx.select().from(clientContact).where(eq(clientContact.id, contactId));
      expect(contact!.erasedAt).toEqual(events[0]!.recordedAt);
      expect(await tx.select().from(auditLog).where(and(eq(auditLog.targetId, contactId), eq(auditLog.action, "contact.erase")))).toHaveLength(1);

      // Event rows are untouched: the earlier log is a prefix of the new one and the chain verifies.
      const after = await readEvents(tx, e.engagementId);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(await verifyEngagementChain(tx, e.engagementId)).toMatchObject({ ok: true, headSeq: before.length + 1 });
      const live = await dumpProjections(tx, e.engagementId);
      await rebuildProjections(tx, e.engagementId);
      expect(await dumpProjections(tx, e.engagementId)).toEqual(live);

      // The record renders "Erased contact" and keeps the response itself.
      const detail = await getItemDetail(tx, e.engagementId, item.itemId);
      expect(detail!.versions[0]!.responses).toMatchObject([{ contactName: "Erased contact", contactErased: true, response: "disputed", comment: null }]);
      const contacts = await listContacts(tx, e.engagementId);
      expect(contacts).toMatchObject([{ id: contactId, name: "Erased contact", email: null, erased: true }]);
      // Nothing in the log was ever the erased data; the commitment rows in the log remain.
      expect((await tx.select({ id: event.id }).from(event).where(eq(event.engagementId, e.engagementId))).length).toBe(before.length + 1);
    });
    const state = await withTenant(app.db, { orgId: e.orgId }, (tx) => loadState(tx, e.engagementId));
    expect(state.erasedContacts.has(contactId)).toBe(true);
  });

  it("rejects erasing twice, unknown contacts and contacts of another engagement; system erasure is allowed", async () => {
    const { e, contactId } = await flow();
    await eraseContact({ ...e.ctx, userId: null }, { engagementId: e.engagementId, contactId });
    const twice = await eraseContact(e.ctx, { engagementId: e.engagementId, contactId }).catch((err: unknown) => err);
    expect((twice as DomainError).code).toBe("contact_erased");
    const unknown = await eraseContact(e.ctx, { engagementId: e.engagementId, contactId: "00000000-0000-4000-8000-0000000000ff" }).catch((err: unknown) => err);
    expect((unknown as DomainError).code).toBe("contact_not_found");
    const other = await createLedgerEngagement(app, admin.db);
    const foreign = await addContact(other.ctx, { engagementId: other.engagementId, name: "Bo Client", email: "bo@client.example" });
    const cross = await eraseContact(e.ctx, { engagementId: e.engagementId, contactId: foreign.contactId }).catch((err: unknown) => err);
    expect((cross as DomainError).code).toBe("contact_not_found");
  });

  it("erasure and redaction together still leave a verifiable chain", async () => {
    const { e, contactId } = await flow();
    await eraseContact(e.ctx, { engagementId: e.engagementId, contactId });
    await redactSource(e.ctx, { engagementId: e.engagementId, sourceId: e.sourceId, reasonCode: "consent_withdrawn" });
    await withTenant(app.db, { orgId: e.orgId }, async (tx) => {
      expect((await verifyEngagementChain(tx, e.engagementId)).ok).toBe(true);
    });
  });
});
