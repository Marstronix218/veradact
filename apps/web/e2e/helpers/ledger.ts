// E2E ledger fixtures built with the real core commands on the app role (DATABASE_URL, RLS
// enforced), so tests do not depend on other screens for setup. Admin SQL (DATABASE_ADMIN_URL) is
// used only to simulate what the app cannot do, such as moving a link's expiry into the past.
import { randomUUID } from "node:crypto";
import {
  addContact,
  AUTHORIZATION_TEXT_VERSION,
  clientLinkUrl,
  createEngagement,
  createItem,
  ingestSource,
  linkSigningSecret,
  parseLinkToken,
  recordAuthorization,
  recordClientResponses,
  requestConfirmation,
  seedMetricsScenario,
  signLinkToken,
} from "@veradact/core";
import { createDb, withTenant, type DbHandle } from "@veradact/db";

let app: DbHandle | undefined;
let admin: DbHandle | undefined;

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (root .env)`);
  return value;
}

function appDb() {
  app ??= createDb(env("DATABASE_URL"), { max: 2 });
  return app.db;
}

function adminSql() {
  admin ??= createDb(env("DATABASE_ADMIN_URL"), { max: 1 });
  return admin.sql;
}

/** Close the pools in `test.afterAll`. */
export async function closeLedgerDb(): Promise<void> {
  await Promise.all([app?.close(), admin?.close()]);
  app = undefined;
  admin = undefined;
}

/** Synthetic kickoff notes (fictional people and companies); each quoted line appears once. */
const NOTES = [
  "Kickoff call, Halvorsen Freight dispatch rollout.",
  "Dana: The dispatch board must refresh every five minutes.",
  "Lee: Invoices are exported nightly to the carrier portal.",
  "Dana: We assume carriers accept CSV uploads.",
  "",
].join("\n");

export interface LedgerFixture {
  engagementId: string;
  shortCode: string;
  items: { itemId: string; shortId: string; statement: string; version: number; contentHash: string }[];
  contact: { contactId: string; name: string; email: string };
}

/** Engagement + one notes source + three pending sourced items + one client contact. */
export async function createEngagementWithItems(tenant: { orgId: string; userId: string }): Promise<LedgerFixture> {
  const ctx = { db: appDb(), orgId: tenant.orgId, userId: tenant.userId, clock: () => new Date() };
  const shortCode = "HALV";
  const { engagementId } = await createEngagement(ctx, {
    name: "Dispatch rollout",
    clientName: "Halvorsen Freight",
    shortCode,
    timeZone: "America/New_York",
  });
  const { sourceId } = await ingestSource(ctx, {
    engagementId,
    parsed: { text: NOTES, rawText: NOTES, segments: [] },
    title: "Kickoff notes",
    filename: "kickoff.md",
    format: "md",
    sourceType: "human_notes",
    occurredAt: new Date(Date.now() - 7 * 86_400_000),
    participants: ["Dana", "Lee"],
    attestation: { allParticipantsConsented: null, jurisdictions: [], jurisdictionsKnown: false },
  });
  const specs = [
    { kind: "requirement" as const, statement: "The dispatch board refreshes every five minutes.", quote: "The dispatch board must refresh every five minutes." },
    { kind: "requirement" as const, statement: "Invoices are exported nightly to the carrier portal.", quote: "Invoices are exported nightly to the carrier portal." },
    { kind: "assumption" as const, statement: "Carriers accept CSV uploads.", quote: "We assume carriers accept CSV uploads." },
  ];
  const items: LedgerFixture["items"] = [];
  for (const s of specs) {
    const created = await createItem(ctx, { engagementId, kind: s.kind, statement: s.statement, spans: [{ sourceId, quote: s.quote }] });
    items.push({ itemId: created.itemId, shortId: created.shortId, statement: s.statement, version: created.version, contentHash: created.contentHash });
  }
  const contact = { name: "Ada Client", email: `e2e-client-${randomUUID().slice(0, 8)}@example.test` };
  const { contactId } = await addContact(ctx, { engagementId, ...contact });
  return { engagementId, shortCode, items, contact: { contactId, ...contact } };
}

/** A request for every fixture item to the contact, and its signed client URL (no email sent). */
export async function createRequestLink(tenant: { orgId: string; userId: string }, fixture: LedgerFixture): Promise<string> {
  const ctx = { db: appDb(), orgId: tenant.orgId, userId: tenant.userId, clock: () => new Date() };
  const { links } = await requestConfirmation(ctx, {
    engagementId: fixture.engagementId,
    items: fixture.items.map((i) => ({ itemId: i.itemId })),
    contactIds: [fixture.contact.contactId],
  });
  const link = links[0]!;
  const token = signLinkToken({ secret: linkSigningSecret(), linkId: link.linkId, contactId: link.contactId, expiresAt: link.expiresAt });
  return clientLinkUrl(env("APP_URL"), token);
}

/**
 * The client side of a confirmation done through the channel-agnostic commands: the fixture's
 * contact grants authorization on the request behind `clientUrl` and confirms the first item.
 */
export async function confirmFirstItem(tenant: { orgId: string }, fixture: LedgerFixture, clientUrl: string): Promise<void> {
  const parsed = parseLinkToken(clientUrl.split("/c/")[1] ?? "");
  if (!parsed) throw new Error("not a client link");
  const [row] = await adminSql()`select request_id from confirmation_link where id = ${parsed.linkId}`;
  const requestId = (row as { request_id: string }).request_id;
  const client = { db: appDb(), orgId: tenant.orgId, clock: () => new Date() };
  const evidence = { ip: "192.0.2.80", userAgent: "Mozilla/5.0 (synthetic e2e)" };
  const { contactId } = fixture.contact;
  await recordAuthorization(client, {
    engagementId: fixture.engagementId,
    requestId,
    contactId,
    decision: "granted",
    text: "I authorize Veradact to record my responses.",
    textVersion: AUTHORIZATION_TEXT_VERSION,
    evidence,
  });
  const item = fixture.items[0]!;
  await recordClientResponses(client, {
    channel: "email_link",
    engagementId: fixture.engagementId,
    requestId,
    contactId,
    submissionId: randomUUID(),
    responses: [{ itemId: item.itemId, version: item.version, contentHash: item.contentHash, decision: "confirmed" }],
    evidence,
  });
}

/** Moves every link of this contact into the past (simulates expiry; admin URL, test only). */
export async function expireLinksOf(contactId: string): Promise<void> {
  await adminSql()`update confirmation_link set expires_at = ${new Date(Date.now() - 60_000)} where contact_id = ${contactId}`;
}

/** The deterministic metrics scenario (60%, on target at `now`) in the org, via the real commands. */
export async function seedMetricsOrg(tenant: { orgId: string; userId: string }, now: Date) {
  return withTenant(appDb(), { orgId: tenant.orgId }, (tx) => seedMetricsScenario(tx, { ...tenant, now }));
}
