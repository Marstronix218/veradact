// The client confirmation flow end to end at the service level: link tokens (§8.2), delivery,
// authorization (D-019), submissions with receipts and notifications (§8.3–§8.5, D-020).
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { auditLog, confirmationLink, notification, withTenant } from "@veradact/db";
import { adminTestDb, testDb } from "@veradact/db/testing";
import { MemoryEmailProvider, type EmailMessage } from "@veradact/email";
import { extractFirstLink } from "@veradact/email/mailpit";
import { addContact, createItem, eraseContact, recordAuthorization, reviseItem, revokeConfirmation } from "../commands";
import { sha256Hex } from "../domain";
import { listNotifications, markAllRead, markRead, unreadCount } from "../notifications";
import { readEvents, verifyEngagementChain } from "../store";
import { clientContext, createLedgerEngagement, type LedgerEngagement } from "../test-support/ledger";
import { AUTHORIZATION_TEXT_VERSION } from "./authorization-text";
import { EmailLinkChannel, sendConfirmationRequest, type ConfirmationChannel, type ConfirmationDelivery } from "./channels";
import { clientAuthorize, clientSubmit, recordLinkInteraction, recordLinkOpen, type ClientFormResponse } from "./client-actions";
import { loadClientView } from "./client-view";
import { linkSigningSecret, parseLinkToken, resolveClientLink, signLinkToken, type ClientLinkContext } from "./link-token";
import { listOpenDisputes } from "./vendor-queries";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

const APP_URL = "http://veradact.test";
const EVIDENCE = { ip: "192.0.2.44", userAgent: "Mozilla/5.0 (synthetic)" };

function tokenFrom(message: EmailMessage | undefined): string {
  if (!message) throw new Error("no email");
  return extractFirstLink(message.text, "/c/").split("/c/")[1]!;
}

interface Flow {
  e: LedgerEngagement;
  email: MemoryEmailProvider;
  items: { itemId: string; shortId: string; contentHash: string }[];
  contacts: { contactId: string; email: string }[];
  requestId: string;
  tokens: string[];
  links: ClientLinkContext[];
}

/** Engagement with two sourced items and one manual item, sent to `contactCount` contacts. */
async function flow(contactCount = 1): Promise<Flow> {
  const e = await createLedgerEngagement(app, admin.db);
  const a = await createItem(e.ctx, {
    engagementId: e.engagementId,
    kind: "requirement",
    statement: "The dispatch dashboard refreshes every five minutes.",
    spans: [{ sourceId: e.sourceId, quote: "The dispatch dashboard must refresh every five minutes." }],
  });
  const b = await createItem(e.ctx, {
    engagementId: e.engagementId,
    kind: "assumption",
    statement: "Carriers accept CSV uploads.",
    spans: [{ sourceId: e.sourceId, quote: "We assume carriers accept CSV uploads." }],
  });
  const c = await createItem(e.ctx, { engagementId: e.engagementId, kind: "decision", statement: "Staff log in with the existing SSO provider.", manual: true });
  const contacts: Flow["contacts"] = [];
  for (let i = 0; i < contactCount; i++) {
    const address = `contact-${randomUUID().slice(0, 8)}@client.example`;
    const { contactId } = await addContact(e.ctx, { engagementId: e.engagementId, name: i === 0 ? "Ada Client" : `Contact ${i}`, email: address });
    contacts.push({ contactId, email: address });
  }
  const email = new MemoryEmailProvider();
  const sent = await sendConfirmationRequest(e.ctx, {
    engagementId: e.engagementId,
    items: [a, b, c].map((i) => ({ itemId: i.itemId, version: 1, contentHash: i.contentHash })),
    contactIds: contacts.map((x) => x.contactId),
    appUrl: APP_URL,
    channel: new EmailLinkChannel(email),
  });
  const tokens = contacts.map((x) => tokenFrom(email.lastTo(x.email)));
  const links: ClientLinkContext[] = [];
  for (const token of tokens) {
    const resolved = await resolveClientLink({ db: app.db, token, clock: e.ctx.clock });
    if (!resolved.ok) throw new Error("link did not resolve");
    links.push(resolved.ctx);
  }
  return { e, email, items: [a, b, c], contacts, requestId: sent.requestId, tokens, links };
}

function handle(f: Flow, i = 0) {
  return { db: app.db, link: f.links[i]!, clock: f.e.ctx.clock };
}

function grant(f: Flow, i = 0) {
  return clientAuthorize({ ...handle(f, i), decision: "granted", shownTextSha256: null, evidence: EVIDENCE, emailProvider: f.email, appUrl: APP_URL });
}

function submit(f: Flow, responses: ClientFormResponse[], opts: { submissionId?: string; contact?: number } = {}) {
  return clientSubmit({
    ...handle(f, opts.contact ?? 0),
    submissionId: opts.submissionId ?? randomUUID(),
    responses,
    evidence: EVIDENCE,
    emailProvider: f.email,
    appUrl: APP_URL,
  });
}

const respond = (item: { itemId: string; contentHash: string }, decision: ClientFormResponse["decision"], comment = "", version = 1): ClientFormResponse => ({
  itemId: item.itemId,
  version,
  contentHash: item.contentHash,
  decision,
  comment,
});

function requesterEmail(f: Flow): string {
  return `user-${f.e.userId}@example.test`;
}

describe("sendConfirmationRequest", () => {
  it("emails each contact a signed link, sets email_sent_at, and audits the request", async () => {
    const f = await flow(2);
    for (const c of f.contacts) {
      const message = f.email.lastTo(c.email)!;
      expect(message.subject).toMatch(/asks you to confirm 3 items for Synthetic engagement/);
      expect(message.text).toMatch(/Test User at Test Org/);
      expect(message.text).toContain(`${APP_URL}/c/v1.`);
      expect(message.text).toMatch(/expires on \w+day, March 16, 2026/);
      expect(message.html).not.toMatch(/<img|<script/i);
      expect(message.tags).toEqual({ kind: "confirmation_request", request_id: f.requestId });
    }
    await withTenant(app.db, { orgId: f.e.orgId }, async (tx) => {
      const links = await tx.select().from(confirmationLink).where(eq(confirmationLink.requestId, f.requestId));
      expect(links).toHaveLength(2);
      expect(links.every((l) => l.emailSentAt !== null)).toBe(true);
      expect(await tx.select().from(auditLog).where(and(eq(auditLog.targetId, f.requestId), eq(auditLog.action, "confirmation.request")))).toHaveLength(1);
    });
    expect(f.links.map((l) => l.contactId)).toEqual(f.contacts.map((c) => c.contactId));
  });

  it("keeps the request when one delivery fails and leaves that link without email_sent_at", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const item = await createItem(e.ctx, { engagementId: e.engagementId, kind: "requirement", statement: "R", manual: true });
    const ok = await addContact(e.ctx, { engagementId: e.engagementId, name: "Ok Client", email: "ok@client.example" });
    const bad = await addContact(e.ctx, { engagementId: e.engagementId, name: "Bad Client", email: "bad@client.example" });
    const delivered: ConfirmationDelivery[] = [];
    const channel: ConfirmationChannel = {
      name: "email_link",
      async deliver(d) {
        if (d.contact.id === bad.contactId) throw new Error("smtp down");
        delivered.push(d);
      },
    };
    const result = await sendConfirmationRequest(e.ctx, { engagementId: e.engagementId, items: [{ itemId: item.itemId }], contactIds: [ok.contactId, bad.contactId], appUrl: APP_URL, channel });
    expect(result).toMatchObject({ sentCount: 1, failedCount: 1 });
    expect(result.deliveries.find((d) => d.contactId === bad.contactId)!.sent).toBe(false);
    expect(delivered.map((d) => d.kind)).toEqual(["request"]);
    await withTenant(app.db, { orgId: e.orgId }, async (tx) => {
      const links = await tx.select().from(confirmationLink).where(eq(confirmationLink.requestId, result.requestId));
      expect(Object.fromEntries(links.map((l) => [l.contactId, l.emailSentAt !== null]))).toEqual({ [ok.contactId]: true, [bad.contactId]: false });
    });
  });
});

describe("resolveClientLink", () => {
  it("accepts a valid token and rejects every tampered, expired, revoked or erased variant the same way", async () => {
    const f = await flow(2);
    const [tokenA, tokenB] = f.tokens as [string, string];
    const a = parseLinkToken(tokenA)!;
    const b = parseLinkToken(tokenB)!;
    const secret = linkSigningSecret();
    const clock = f.e.ctx.clock;
    const resolve = (token: string) => resolveClientLink({ db: app.db, token, clock });

    expect(await resolve(tokenA)).toEqual({ ok: true, ctx: f.links[0] });
    const invalid = { ok: false };
    const flipped = tokenA.slice(0, -1) + (tokenA.endsWith("A") ? "B" : "A");
    expect(await resolve(flipped)).toEqual(invalid); // tampered signature
    expect(await resolve(`v1.${b.linkId}.${a.exp}.${a.sig}`)).toEqual(invalid); // A's signature on B's link
    expect(await resolve(signLinkToken({ secret, linkId: b.linkId, contactId: f.contacts[0]!.contactId, expiresAt: new Date(a.exp * 1000) }))).toEqual(invalid); // B's link signed for A
    expect(await resolve(signLinkToken({ secret, linkId: a.linkId, contactId: f.contacts[0]!.contactId, expiresAt: new Date("2026-03-01T00:00:00Z") }))).toEqual(invalid); // expired exp
    expect(await resolve(signLinkToken({ secret: "x".repeat(40), linkId: a.linkId, contactId: f.contacts[0]!.contactId, expiresAt: new Date(a.exp * 1000) }))).toEqual(invalid); // other secret
    expect(await resolve(`v1.${randomUUID()}.${a.exp}.${a.sig}`)).toEqual(invalid); // unknown link
    expect(await resolve("not-a-token")).toEqual(invalid);
    // Past its expiry by the clock.
    expect(await resolveClientLink({ db: app.db, token: tokenA, clock: () => new Date(a.exp * 1000) })).toEqual(invalid);

    // DB expiry earlier than the token's exp.
    await admin.db.update(confirmationLink).set({ expiresAt: new Date("2026-03-02T00:00:00Z") }).where(eq(confirmationLink.id, b.linkId));
    expect(await resolve(tokenB)).toEqual(invalid);

    // Revoked link (per contact).
    await revokeConfirmation(f.e.ctx, { engagementId: f.e.engagementId, requestId: f.requestId, contactId: f.contacts[0]!.contactId });
    expect(await resolve(tokenA)).toEqual(invalid);
  });

  it("rejects a link whose request was revoked in the log or whose contact was erased, even if the link row says otherwise", async () => {
    const f = await flow(2);
    const clock = f.e.ctx.clock;
    await revokeConfirmation(f.e.ctx, { engagementId: f.e.engagementId, requestId: f.requestId });
    await admin.db.update(confirmationLink).set({ revokedAt: null }).where(eq(confirmationLink.requestId, f.requestId));
    expect(await resolveClientLink({ db: app.db, token: f.tokens[0]!, clock })).toEqual({ ok: false });

    const g = await flow(1);
    await eraseContact(g.e.ctx, { engagementId: g.e.engagementId, contactId: g.contacts[0]!.contactId });
    await admin.db.update(confirmationLink).set({ revokedAt: null }).where(eq(confirmationLink.requestId, g.requestId));
    expect(await resolveClientLink({ db: app.db, token: g.tokens[0]!, clock: g.e.ctx.clock })).toEqual({ ok: false });
  });
});

describe("client view and link tracking", () => {
  it("shows verified quotes, manual items, the authorization text, and counts opens and the first interaction", async () => {
    const f = await flow();
    const view = await loadClientView(app.db, f.links[0]!, { clock: f.e.ctx.clock });
    expect(view).toMatchObject({
      engagementName: "Synthetic engagement",
      clientName: "Fictional Client Co",
      contactName: "Ada Client",
      authorization: { status: "required", reason: "none" },
      authorizationTextVersion: AUTHORIZATION_TEXT_VERSION,
      updatedItems: [],
    });
    expect(view.vendorName).toMatch(/^Test Org/);
    expect(view.authorizationTextSha256).toBe(sha256Hex(view.authorizationText));
    expect(view.items.map((i) => [i.kind, i.manual, i.quotes.map((q) => [q.state, q.quote])])).toEqual([
      ["assumption", false, [["verified", "We assume carriers accept CSV uploads."]]],
      ["decision", true, []],
      ["requirement", false, [["verified", "The dispatch dashboard must refresh every five minutes."]]],
    ]);
    expect(view.items[0]!.quotes[0]!.sourceDate).toEqual(f.e.sourceOccurredAt);

    await recordLinkOpen(handle(f));
    await recordLinkOpen(handle(f));
    await recordLinkInteraction(handle(f));
    await recordLinkInteraction(handle(f));
    const [link] = await withTenant(app.db, { orgId: f.e.orgId }, (tx) => tx.select().from(confirmationLink).where(eq(confirmationLink.id, f.links[0]!.linkId)));
    expect(link!.openCount).toBe(2);
    expect(link!.firstOpenedAt!.getTime()).toBeLessThan(link!.lastOpenedAt!.getTime());
    expect(link!.firstInteractionAt!.getTime()).toBeLessThan(link!.lastOpenedAt!.getTime() + 10_000);
    const firstInteraction = link!.firstInteractionAt!.getTime();
    await recordLinkInteraction(handle(f));
    const [again] = await withTenant(app.db, { orgId: f.e.orgId }, (tx) => tx.select().from(confirmationLink).where(eq(confirmationLink.id, f.links[0]!.linkId)));
    expect(again!.firstInteractionAt!.getTime()).toBe(firstInteraction);
  });

  it("shows a word diff against the previously confirmed version and lists items updated since the request", async () => {
    const f = await flow();
    const [a, b] = f.items as [Flow["items"][number], Flow["items"][number]];
    await grant(f);
    await submit(f, [respond(a, "confirm")]);
    const v2 = await reviseItem(f.e.ctx, { engagementId: f.e.engagementId, itemId: a.itemId, statement: "The dispatch dashboard refreshes every two minutes.", reasonCode: "scope_change" });
    await reviseItem(f.e.ctx, { engagementId: f.e.engagementId, itemId: b.itemId, statement: "Carriers accept CSV or XML uploads.", reasonCode: "correction" });

    // The old request now shows both items as updated.
    const old = await loadClientView(app.db, f.links[0]!, { clock: f.e.ctx.clock });
    expect(old.updatedItems.map((i) => i.itemId).sort()).toEqual([a.itemId, b.itemId].sort());
    expect(old.items.map((i) => i.kind)).toEqual(["decision"]);

    // A new request for v2 shows the diff against confirmed v1.
    const sent = await sendConfirmationRequest(f.e.ctx, { engagementId: f.e.engagementId, items: [{ itemId: a.itemId }], contactIds: [f.contacts[0]!.contactId], appUrl: APP_URL, channel: new EmailLinkChannel(f.email) });
    const resolved = await resolveClientLink({ db: app.db, token: tokenFrom(f.email.lastTo(f.contacts[0]!.email)), clock: f.e.ctx.clock });
    expect(resolved.ok && resolved.ctx.requestId).toBe(sent.requestId);
    const view = await loadClientView(app.db, (resolved as { ctx: ClientLinkContext }).ctx, { clock: f.e.ctx.clock });
    expect(view.authorization.status).toBe("granted");
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({ version: 2, contentHash: v2.contentHash, existingResponse: null });
    expect(view.items[0]!.previouslyConfirmed).toEqual({
      version: 1,
      statement: "The dispatch dashboard refreshes every five minutes.",
      diff: [
        { op: "equal", text: "The dispatch dashboard refreshes every " },
        { op: "delete", text: "five" },
        { op: "insert", text: "two" },
        { op: "equal", text: " minutes." },
      ],
    });
  });
});

describe("authorization", () => {
  it("records the exact rendered text and version; a decline notifies and emails the requester and blocks submissions", async () => {
    const f = await flow();
    const declined = await clientAuthorize({ ...handle(f), decision: "declined", shownTextSha256: null, evidence: EVIDENCE, emailProvider: f.email, appUrl: APP_URL });
    expect(declined).toEqual({ status: "recorded", decision: "declined" });

    const view = await loadClientView(app.db, f.links[0]!, { clock: f.e.ctx.clock });
    expect(view.authorization.status).toBe("declined");
    const events = await withTenant(app.db, { orgId: f.e.orgId }, (tx) => readEvents(tx, f.e.engagementId));
    const decline = events.find((ev) => ev.type === "authorization_declined")!;
    expect(decline.payload).toMatchObject({ text: view.authorizationText, text_version: "auth.v1", text_sha256: view.authorizationTextSha256 });
    expect(JSON.stringify(decline.payload)).not.toMatch(/Ada|192\.0\.2|Mozilla/);

    const notice = f.email.lastTo(requesterEmail(f))!;
    expect(notice.subject).toBe("Ada Client declined authorization for Synthetic engagement");
    expect(notice.text).toContain(`${APP_URL}/engagements/${f.e.engagementId}/confirmations`);
    await withTenant(app.db, { orgId: f.e.orgId }, async (tx) => {
      expect(await listNotifications(tx, f.e.userId)).toMatchObject([
        { kind: "authorization_declined", engagementId: f.e.engagementId, contactId: f.contacts[0]!.contactId, contactName: "Ada Client", itemId: null, readAt: null },
      ]);
    });

    expect(await submit(f, [respond(f.items[0]!, "confirm")])).toEqual({ status: "authorization_required" });
    // Returning later and granting works (D-019: the latest decision wins).
    expect(await grant(f)).toEqual({ status: "recorded", decision: "granted" });
    expect((await submit(f, [respond(f.items[0]!, "confirm")])).status).toBe("recorded");
  });

  it("requires a fresh grant when the text version changed, and refuses a grant of text the contact was not shown", async () => {
    const f = await flow();
    await recordAuthorization(clientContext(f.e.ctx), {
      engagementId: f.e.engagementId,
      requestId: f.requestId,
      contactId: f.contacts[0]!.contactId,
      decision: "granted",
      text: "An older authorization text.",
      textVersion: "auth.v0",
      evidence: EVIDENCE,
    });
    const view = await loadClientView(app.db, f.links[0]!, { clock: f.e.ctx.clock });
    expect(view.authorization).toEqual({ status: "required", reason: "text_version_changed" });
    expect(await submit(f, [respond(f.items[0]!, "confirm")])).toEqual({ status: "authorization_required" });

    const changed = await clientAuthorize({ ...handle(f), decision: "granted", shownTextSha256: sha256Hex("some other text"), evidence: EVIDENCE, emailProvider: f.email, appUrl: APP_URL });
    expect(changed).toEqual({ status: "text_changed" });
    expect((await loadClientView(app.db, f.links[0]!, { clock: f.e.ctx.clock })).authorization.status).toBe("required");

    await clientAuthorize({ ...handle(f), decision: "granted", shownTextSha256: view.authorizationTextSha256, evidence: EVIDENCE, emailProvider: f.email, appUrl: APP_URL });
    expect((await loadClientView(app.db, f.links[0]!, { clock: f.e.ctx.clock })).authorization.status).toBe("granted");
    expect((await submit(f, [respond(f.items[0]!, "confirm")])).status).toBe("recorded");
  });
});

describe("clientSubmit", () => {
  it("records confirms and disputes in one batch, notifies and emails the requester, and emails the contact a receipt with hashes", async () => {
    const f = await flow();
    const [a, b, c] = f.items as [Flow["items"][number], Flow["items"][number], Flow["items"][number]];
    await grant(f);
    const result = await submit(f, [respond(a, "confirm"), respond(b, "dispute", "  We send XML, not CSV.  "), respond(c, "skip")]);
    if (result.status !== "recorded") throw new Error(`unexpected ${result.status}`);
    expect(result.duplicate).toBe(false);
    expect(result.receiptEmailSent).toBe(true);
    // Ledger order (kind, then number), like the client page.
    expect(result.receipt.items.map((i) => [i.shortId, i.decision, i.version, i.contentHash])).toEqual([
      [b.shortId, "disputed", 1, b.contentHash],
      [a.shortId, "confirmed", 1, a.contentHash],
    ]);

    await withTenant(app.db, { orgId: f.e.orgId }, async (tx) => {
      const events = await readEvents(tx, f.e.engagementId);
      const last = events.at(-1)!;
      expect(result.receipt.head).toEqual({ seq: last.seq, hash: last.hash });
      expect(events.slice(-2).map((ev) => ev.type)).toEqual(["item_confirmed", "item_disputed"]);
      expect((await verifyEngagementChain(tx, f.e.engagementId, result.receipt.head)).ok).toBe(true);
      const notes = await listNotifications(tx, f.e.userId);
      expect(notes).toMatchObject([{ kind: "item_disputed", itemId: b.itemId, itemShortId: b.shortId, contactName: "Ada Client" }]);
      expect(await listOpenDisputes(tx, f.e.engagementId)).toMatchObject([{ itemId: b.itemId, comment: "We send XML, not CSV.", contactName: "Ada Client", version: 1 }]);
    });

    const receipt = f.email.lastTo(f.contacts[0]!.email)!;
    expect(receipt.subject).toBe("Receipt: your responses for Synthetic engagement were recorded");
    expect(receipt.text).toContain(`${a.shortId} · Confirmed · version 1`);
    expect(receipt.text).toContain(`Content hash: ${b.contentHash}`);
    expect(receipt.text).toContain(`entry ${result.receipt.head.seq}, hash ${result.receipt.head.hash}`);
    const dispute = f.email.lastTo(requesterEmail(f))!;
    expect(dispute.subject).toBe("Ada Client disputed 1 item in Synthetic engagement");
    expect(dispute.text).toContain(b.shortId);
    expect(dispute.text).not.toContain("XML");
  });

  it("requires a comment for a dispute (validated server-side) and records nothing", async () => {
    const f = await flow();
    await grant(f);
    const before = await withTenant(app.db, { orgId: f.e.orgId }, (tx) => readEvents(tx, f.e.engagementId));
    expect(await submit(f, [respond(f.items[0]!, "confirm"), respond(f.items[1]!, "dispute", "   ")])).toEqual({
      status: "invalid",
      errors: { [f.items[1]!.itemId]: "comment_required" },
    });
    expect(await submit(f, [respond(f.items[1]!, "dispute", "x".repeat(5001))])).toEqual({ status: "invalid", errors: { [f.items[1]!.itemId]: "comment_too_long" } });
    const after = await withTenant(app.db, { orgId: f.e.orgId }, (tx) => readEvents(tx, f.e.engagementId));
    expect(after).toHaveLength(before.length);
  });

  it("is idempotent per submission id, skips unchanged responses, and reports stale forms", async () => {
    const f = await flow();
    const [a, b] = f.items as [Flow["items"][number], Flow["items"][number]];
    await grant(f);
    const submissionId = randomUUID();
    const first = await submit(f, [respond(a, "confirm")], { submissionId });
    const emailsAfterFirst = f.email.messages.length;
    const second = await submit(f, [respond(a, "confirm")], { submissionId });
    if (first.status !== "recorded" || second.status !== "recorded") throw new Error("expected recorded");
    expect(second.duplicate).toBe(true);
    expect(second.receiptEmailSent).toBe(false);
    expect(second.receipt.items).toEqual(first.receipt.items);
    expect(f.email.messages).toHaveLength(emailsAfterFirst);

    // Same decision again under a new submission id: nothing new to record.
    expect(await submit(f, [respond(a, "confirm"), respond(b, "skip")])).toEqual({ status: "nothing_to_record" });
    // Changing a response is recorded (D-029).
    expect((await submit(f, [respond(a, "dispute", "Actually every ten minutes.")])).status).toBe("recorded");
    expect(await submit(f, [respond(a, "dispute", "Actually every ten minutes.")])).toEqual({ status: "nothing_to_record" });

    // The item is revised after the form was rendered.
    await reviseItem(f.e.ctx, { engagementId: f.e.engagementId, itemId: b.itemId, statement: "Carriers accept XML uploads.", reasonCode: "client_dispute" });
    expect(await submit(f, [respond(b, "confirm")])).toEqual({ status: "stale" });
    expect(await submit(f, [respond(b, "confirm")], { submissionId: "not-a-uuid" })).toEqual({ status: "stale" });
  });
});

describe("notifications", () => {
  it("counts unread notifications per user and marks them read", async () => {
    const f = await flow();
    await grant(f);
    await submit(f, [respond(f.items[0]!, "dispute", "No."), respond(f.items[1]!, "dispute", "Also no.")]);
    await withTenant(app.db, { orgId: f.e.orgId }, async (tx) => {
      expect(await unreadCount(tx, f.e.userId)).toBe(2);
      const [first] = await listNotifications(tx, f.e.userId);
      expect(await markRead(tx, f.e.userId, [first!.id, "not-a-uuid"], new Date("2026-03-05T00:00:00Z"))).toBe(1);
      expect(await unreadCount(tx, f.e.userId)).toBe(1);
      expect(await listNotifications(tx, f.e.userId, { unreadOnly: true })).toHaveLength(1);
      // Another user's notifications are not theirs to read.
      expect(await markAllRead(tx, randomUUID(), new Date())).toBe(0);
      expect(await markAllRead(tx, f.e.userId, new Date("2026-03-05T00:00:00Z"))).toBe(1);
      expect(await unreadCount(tx, f.e.userId)).toBe(0);
      const rows = await tx.select().from(notification).where(eq(notification.engagementId, f.e.engagementId));
      expect(rows.every((r) => r.readAt !== null)).toBe(true);
    });
    // RLS: another org sees none of them.
    const other = await createLedgerEngagement(app, admin.db);
    const visible = await withTenant(app.db, { orgId: other.orgId }, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from notification`));
    expect(visible[0]!.n).toBe(0);
  });
});
