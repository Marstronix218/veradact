// One reminder per link after N business days in the engagement time zone (ARCHITECTURE §8.6).
// Runs are limited to each test's org because test files share one database.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { confirmationLink, org, withTenant } from "@veradact/db";
import { adminTestDb, testDb } from "@veradact/db/testing";
import { MemoryEmailProvider } from "@veradact/email";
import { extractFirstLink } from "@veradact/email/mailpit";
import { addContact, createItem, revokeConfirmation, withdrawItem } from "../commands";
import { clientAuthorize, clientSubmit, EmailLinkChannel, resolveClientLink, sendConfirmationRequest } from "../confirmation";
import { createLedgerEngagement } from "../test-support/ledger";
import { runReminders } from "./reminders";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

const APP_URL = "http://veradact.test";
// Friday 2026-03-06 10:00 in New York (EST, UTC-5). Two business days later is Tuesday 10:00.
const FRIDAY_10AM = new Date("2026-03-06T15:00:00.000Z");
const TUESDAY_10AM = new Date("2026-03-10T14:00:00.000Z"); // EDT from Sunday 2026-03-08 (UTC-4)

/** Engagement (America/New_York) with one item sent to one contact on Friday 10:00 local. */
async function sentOnFriday() {
  const e = await createLedgerEngagement(app, admin.db, new Date("2026-03-06T14:00:00.000Z"));
  const item = await createItem(e.ctx, { engagementId: e.engagementId, kind: "requirement", statement: "Loads can be reassigned.", manual: true });
  const address = `reminder-${randomUUID().slice(0, 8)}@client.example`;
  const { contactId } = await addContact(e.ctx, { engagementId: e.engagementId, name: "Ada Client", email: address });
  const email = new MemoryEmailProvider();
  const sent = await sendConfirmationRequest(
    { ...e.ctx, clock: () => new Date(FRIDAY_10AM) },
    { engagementId: e.engagementId, items: [{ itemId: item.itemId }], contactIds: [contactId], appUrl: APP_URL, channel: new EmailLinkChannel(email) },
  );
  const linkId = sent.deliveries[0]!.linkId;
  const run = (now: Date) => runReminders({ db: app.db, now, emailProvider: email, appUrl: APP_URL, onlyOrgIds: [e.orgId] });
  const reminderSentAt = async () => {
    const [row] = await withTenant(app.db, { orgId: e.orgId }, (tx) => tx.select().from(confirmationLink).where(eq(confirmationLink.id, linkId)));
    return row!.reminderSentAt;
  };
  const reminders = () => email.messages.filter((m) => m.tags?.kind === "confirmation_reminder");
  return { e, item, contactId, address, email, sent, linkId, run, reminderSentAt, reminders };
}

describe("runReminders", () => {
  it("sends nothing before 2 business days (Friday → Tuesday over the weekend), exactly one after, and never a second", async () => {
    const s = await sentOnFriday();
    for (const now of [new Date("2026-03-09T14:00:00.000Z"), new Date(TUESDAY_10AM.getTime() - 60_000)]) {
      expect(await s.run(now)).toMatchObject({ orgs: 1, sent: 0 });
    }
    expect(s.reminders()).toHaveLength(0);
    expect(await s.reminderSentAt()).toBeNull();

    expect(await s.run(TUESDAY_10AM)).toMatchObject({ due: 1, sent: 1, failed: 0 });
    expect(await s.reminderSentAt()).toEqual(TUESDAY_10AM);
    const [reminder] = s.reminders();
    expect(reminder!.to).toBe(s.address);
    expect(reminder!.subject).toMatch(/^Reminder: Test Org .* is waiting for you to confirm 1 item$/);
    expect(reminder!.text).toMatch(/This is the only reminder you will get/);
    // The reminder carries a freshly signed URL for the same link.
    const token = extractFirstLink(reminder!.text, "/c/").split("/c/")[1]!;
    const resolved = await resolveClientLink({ db: app.db, token, clock: () => TUESDAY_10AM });
    expect(resolved).toMatchObject({ ok: true, ctx: { linkId: s.linkId, contactId: s.contactId } });

    expect(await s.run(new Date("2026-03-12T14:00:00.000Z"))).toMatchObject({ sent: 0 });
    expect(await s.run(new Date("2026-03-13T20:00:00.000Z"))).toMatchObject({ sent: 0 });
    expect(s.reminders()).toHaveLength(1);
  });

  it("follows the org's reminder_business_days setting", async () => {
    const s = await sentOnFriday();
    await admin.db.update(org).set({ reminderBusinessDays: 3 }).where(eq(org.id, s.e.orgId));
    expect(await s.run(TUESDAY_10AM)).toMatchObject({ sent: 0 });
    expect(await s.run(new Date("2026-03-11T14:00:00.000Z"))).toMatchObject({ sent: 1 });
  });

  it("skips contacts who already responded, revoked and expired links, and requests with nothing pending", async () => {
    const responded = await sentOnFriday();
    const resolved = await resolveClientLink({ db: app.db, token: extractFirstLink(responded.email.lastTo(responded.address)!.text, "/c/").split("/c/")[1]!, clock: () => FRIDAY_10AM });
    if (!resolved.ok) throw new Error("link did not resolve");
    const handle = { db: app.db, link: resolved.ctx, clock: () => new Date("2026-03-06T16:00:00.000Z") };
    await clientAuthorize({ ...handle, decision: "granted", shownTextSha256: null, evidence: { ip: null, userAgent: null }, emailProvider: responded.email, appUrl: APP_URL });
    // A dispute is a response too: the reminder is for contacts who have not answered at all.
    await clientSubmit({
      ...handle,
      submissionId: randomUUID(),
      responses: [{ itemId: responded.item.itemId, version: 1, contentHash: responded.item.contentHash, decision: "dispute", comment: "Not quite." }],
      evidence: { ip: null, userAgent: null },
      emailProvider: responded.email,
      appUrl: APP_URL,
    });
    expect(await responded.run(TUESDAY_10AM)).toMatchObject({ due: 1, sent: 0 });

    const revoked = await sentOnFriday();
    await revokeConfirmation({ ...revoked.e.ctx, clock: () => new Date("2026-03-09T15:00:00.000Z") }, { engagementId: revoked.e.engagementId, requestId: revoked.sent.requestId });
    expect(await revoked.run(TUESDAY_10AM)).toMatchObject({ sent: 0 });

    const expired = await sentOnFriday();
    await admin.db.update(confirmationLink).set({ expiresAt: new Date("2026-03-09T15:00:00.000Z") }).where(eq(confirmationLink.id, expired.linkId));
    expect(await expired.run(TUESDAY_10AM)).toMatchObject({ due: 0, sent: 0 });

    const withdrawn = await sentOnFriday();
    await withdrawItem({ ...withdrawn.e.ctx, clock: () => new Date("2026-03-09T15:00:00.000Z") }, { engagementId: withdrawn.e.engagementId, itemId: withdrawn.item.itemId, reasonCode: "out_of_scope" });
    expect(await withdrawn.run(TUESDAY_10AM)).toMatchObject({ due: 1, sent: 0 });

    for (const s of [responded, revoked, expired, withdrawn]) {
      expect(s.reminders()).toHaveLength(0);
      expect(await s.reminderSentAt()).toBeNull();
    }
  });

  it("releases the claim when delivery fails so the next run retries", async () => {
    const s = await sentOnFriday();
    const failing = { name: "email_link" as const, deliver: async () => Promise.reject(new Error("smtp down")) };
    expect(await runReminders({ db: app.db, now: TUESDAY_10AM, emailProvider: s.email, appUrl: APP_URL, channel: failing, onlyOrgIds: [s.e.orgId] })).toMatchObject({ sent: 0, failed: 1 });
    expect(await s.reminderSentAt()).toBeNull();
    expect(await s.run(new Date(TUESDAY_10AM.getTime() + 3_600_000))).toMatchObject({ sent: 1 });
  });
});
