// Tenant isolation at the application layer (invariant 7, ARCHITECTURE §7): with org A's context,
// every core command and query that takes an id, given org B's id, behaves exactly as for an id
// that never existed — a not-found error (never another error that would reveal existence) or an
// empty/null result — and nothing in org B changes. The DB-level RLS tests live in packages/db;
// the @veradact/export/server loaders are covered the same way in apps/mcp (core cannot import
// export).
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockModelClient } from "@veradact/ai";
import { withTenant, type Tx } from "@veradact/db";
import { adminTestDb, testDb } from "@veradact/db/testing";
import { MemoryEmailProvider } from "@veradact/email";
import { extractFirstLink } from "@veradact/email/mailpit";
import { createApiToken, listApiTokens, revokeApiToken } from "../api-tokens";
import {
  addContact,
  addDependency,
  archiveEngagement,
  clearReview,
  createItem,
  eraseContact,
  ingestSource,
  reactivateEngagement,
  recordAuthorization,
  recordClientResponses,
  redactSource,
  removeDependency,
  requestConfirmation,
  reviseItem,
  revokeConfirmation,
  setClientEmailDomains,
  supersedeItem,
  updateContact,
  updateEngagement,
  withdrawItem,
} from "../commands";
import { AUTHORIZATION_TEXT_VERSION } from "../confirmation/authorization-text";
import {
  clientAuthorize,
  clientSubmit,
  EmailLinkChannel,
  listOpenDisputes,
  loadDeliveryContext,
  recordLinkInteraction,
  recordLinkOpen,
  resolveClientLink,
  sendConfirmationRequest,
  type ClientLinkContext,
} from "../confirmation";
import { CoreError } from "../errors";
import { runExtraction, setEngagementAiEnabled } from "../extraction";
import { buildMetricsCsv, loadEngagementMetrics, loadOrgMetrics } from "../metrics-queries";
import { listNotifications, markAllRead, markRead, unreadCount } from "../notifications";
import { deactivateUser, getCurrentUser, listUsers } from "../org";
import { getEngagementSummary, getItemDetail, getSourceDetail, listConfirmationRequests, listContacts, listEngagements, listItems, listSources } from "../queries";
import { acceptCandidate, listCandidates, listExtractionRuns, rejectCandidate } from "../review";
import { dumpProjections, loadState, readEngagementHead, readEvents } from "../store";
import { createLedgerEngagement, createLedgerUser, NOTES_TEXT, type LedgerEngagement } from "../test-support/ledger";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

const APP_URL = "http://veradact.test";
const clock = () => new Date();
const QUOTE = "Lee: Invoices are exported nightly to the carrier portal.";

interface Tenant {
  e: LedgerEngagement;
  itemId: string;
  requirementId: string;
  contactId: string;
  requestId: string;
  link: ClientLinkContext;
  candidateId: string;
  notificationId: string;
  apiTokenId: string;
  memberId: string;
}

/** An org with one of everything: items, a source, a contact, a request with a link, a dispute
 *  (and its notification), a pending candidate, an API token and a second user. */
async function populatedOrg(): Promise<Tenant> {
  const e = await createLedgerEngagement(app, admin.db, new Date());
  const ctx = { ...e.ctx, clock };
  const decision = await createItem(ctx, { engagementId: e.engagementId, kind: "decision", statement: "Invoices go out nightly.", spans: [{ sourceId: e.sourceId, quote: QUOTE }] });
  const requirement = await createItem(ctx, { engagementId: e.engagementId, kind: "requirement", statement: "Export to the carrier portal.", manual: true, dependsOn: [decision.itemId] });
  const address = `contact-${randomUUID().slice(0, 8)}@client.example`;
  const { contactId } = await addContact(ctx, { engagementId: e.engagementId, name: "Ada Client", email: address });
  const email = new MemoryEmailProvider();
  const sent = await sendConfirmationRequest(ctx, {
    engagementId: e.engagementId,
    items: [{ itemId: decision.itemId }, { itemId: requirement.itemId }],
    contactIds: [contactId],
    appUrl: APP_URL,
    channel: new EmailLinkChannel(email),
  });
  const token = extractFirstLink(email.lastTo(address)!.text, "/c/").split("/c/")[1]!;
  const resolved = await resolveClientLink({ db: app.db, token, clock });
  if (!resolved.ok) throw new Error("link did not resolve");
  const handle = { db: app.db, link: resolved.ctx, clock, evidence: { ip: null, userAgent: null }, emailProvider: email, appUrl: APP_URL };
  await clientAuthorize({ ...handle, decision: "granted", shownTextSha256: null });
  await clientSubmit({ ...handle, submissionId: randomUUID(), responses: [{ itemId: decision.itemId, version: 1, contentHash: decision.contentHash, decision: "dispute", comment: "Weekly, not nightly." }] });
  const mock = new MockModelClient([
    [{ kind: "requirement", statement: "Invoices reach the carrier portal nightly.", quote: QUOTE, start: NOTES_TEXT.indexOf(QUOTE), end: NOTES_TEXT.indexOf(QUOTE) + QUOTE.length, speaker_label: "Lee", confidence: 0.9, suggested_depends_on: [], revises: null }],
  ]);
  await runExtraction({ db: app.db, orgId: e.orgId, userId: e.userId, engagementId: e.engagementId, sourceId: e.sourceId, clock, modelClientFactory: () => mock });
  const auth = { orgId: e.orgId, userId: e.userId, role: "admin" as const };
  const apiToken = await createApiToken({ db: app.db, ctx: auth, clock, name: "Coding agent" });
  const memberId = await createLedgerUser(admin.db, e.orgId);
  const ids = await withTenant(app.db, { orgId: e.orgId }, async (tx) => ({
    candidateId: (await listCandidates(tx, e.engagementId))[0]!.candidates[0]!.id,
    notificationId: (await listNotifications(tx, e.userId))[0]!.id,
  }));
  return { e, itemId: decision.itemId, requirementId: requirement.itemId, contactId, requestId: sent.requestId, link: resolved.ctx, apiTokenId: apiToken.id, memberId, ...ids };
}

/** Every row of every table with an `org_id` column for this org (admin connection, bypasses RLS). */
async function orgSnapshot(orgId: string): Promise<Record<string, unknown[]>> {
  const tables = await admin.db.execute<{ table_name: string }>(sql`
    select c.table_name from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and c.column_name = 'org_id' and t.table_type = 'BASE TABLE'
    order by c.table_name`);
  const out: Record<string, unknown[]> = {};
  for (const { table_name } of tables) {
    out[table_name] = await admin.db.execute(sql`select * from ${sql.identifier(table_name)} where org_id = ${orgId} order by 1`);
  }
  out.org = await admin.db.execute(sql`select * from org where id = ${orgId}`);
  return out;
}

const NOT_FOUND = /(^|_)not_found$/;

function errorShape(error: unknown): string {
  if (error instanceof CoreError) return `${error.constructor.name}:${error.code}`;
  return `unexpected:${error instanceof Error ? error.name : typeof error}`;
}

async function outcome(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "resolved",
    (error: unknown) => errorShape(error),
  );
}

let A: Tenant;
let B: Tenant;
let before: Record<string, unknown[]>;

beforeAll(async () => {
  [A, B] = await Promise.all([populatedOrg(), populatedOrg()]);
  before = await orgSnapshot(B.e.orgId);
}, 60_000);

/**
 * A command given org B's id. `notFound: false` marks a secondary reference (a dependency target,
 * a supersede target, a contact without authorization in A) whose error is not a not-found code
 * but must still be identical to the error for an id that never existed.
 */
interface CommandCase {
  name: string;
  foreign: () => string;
  run: (id: string) => Promise<unknown>;
  notFound?: boolean;
}

describe("cross-tenant commands: org B's ids fail exactly like unknown ids", () => {
  const ctx = () => ({ ...A.e.ctx, clock });
  const auth = () => ({ orgId: A.e.orgId, userId: A.e.userId, role: "admin" as const });
  const client = () => ({ db: app.db, orgId: A.e.orgId, clock });
  const engA = () => A.e.engagementId;
  const parsed = { text: NOTES_TEXT, rawText: NOTES_TEXT, segments: [] };
  const attestation = { allParticipantsConsented: null, jurisdictions: [], jurisdictionsKnown: false };

  const cases: CommandCase[] = [
    // Engagement ids
    { name: "updateEngagement", foreign: () => B.e.engagementId, run: (id) => updateEngagement(ctx(), { engagementId: id, name: "Hijacked" }) },
    { name: "archiveEngagement", foreign: () => B.e.engagementId, run: (id) => archiveEngagement(ctx(), { engagementId: id }) },
    { name: "reactivateEngagement", foreign: () => B.e.engagementId, run: (id) => reactivateEngagement(ctx(), { engagementId: id }) },
    { name: "setEngagementAiEnabled", foreign: () => B.e.engagementId, run: (id) => setEngagementAiEnabled(ctx(), { engagementId: id, enabled: false }) },
    { name: "setClientEmailDomains", foreign: () => B.e.engagementId, run: (id) => setClientEmailDomains(ctx(), { engagementId: id, domains: "evil.example" }) },
    { name: "addContact", foreign: () => B.e.engagementId, run: (id) => addContact(ctx(), { engagementId: id, name: "Mallory", email: "mallory@evil.example" }) },
    { name: "ingestSource", foreign: () => B.e.engagementId, run: (id) => ingestSource(ctx(), { engagementId: id, parsed, format: "md", sourceType: "human_notes", occurredAt: new Date(), attestation }) },
    { name: "createItem", foreign: () => B.e.engagementId, run: (id) => createItem(ctx(), { engagementId: id, kind: "requirement", statement: "x", manual: true }) },
    { name: "runExtraction (engagement)", foreign: () => B.e.engagementId, run: (id) => runExtraction({ db: app.db, orgId: A.e.orgId, userId: A.e.userId, engagementId: id, sourceId: B.e.sourceId, clock, modelClientFactory: () => new MockModelClient() }) },
    // Item ids
    { name: "reviseItem", foreign: () => B.itemId, run: (id) => reviseItem(ctx(), { engagementId: engA(), itemId: id, statement: "x", reasonCode: "correction" }) },
    { name: "withdrawItem", foreign: () => B.itemId, run: (id) => withdrawItem(ctx(), { engagementId: engA(), itemId: id, reasonCode: "out_of_scope" }) },
    { name: "supersedeItem (item)", foreign: () => B.itemId, run: (id) => supersedeItem(ctx(), { engagementId: engA(), itemId: id, supersededByItemId: A.requirementId, reasonCode: "duplicate" }) },
    { name: "supersedeItem (target)", foreign: () => B.itemId, run: (id) => supersedeItem(ctx(), { engagementId: engA(), itemId: A.requirementId, supersededByItemId: id, reasonCode: "duplicate" }), notFound: false },
    { name: "addDependency (dependent)", foreign: () => B.requirementId, run: (id) => addDependency(ctx(), { engagementId: engA(), itemId: id, dependsOnItemId: A.itemId }) },
    { name: "addDependency (target)", foreign: () => B.itemId, run: (id) => addDependency(ctx(), { engagementId: engA(), itemId: A.requirementId, dependsOnItemId: id }), notFound: false },
    { name: "removeDependency", foreign: () => B.requirementId, run: (id) => removeDependency(ctx(), { engagementId: engA(), itemId: id, dependsOnItemId: B.itemId }) },
    { name: "clearReview", foreign: () => B.itemId, run: (id) => clearReview(ctx(), { engagementId: engA(), itemId: id }) },
    { name: "requestConfirmation (item)", foreign: () => B.requirementId, run: (id) => requestConfirmation(ctx(), { engagementId: engA(), items: [{ itemId: id }], contactIds: [A.contactId] }) },
    // Source ids
    { name: "redactSource", foreign: () => B.e.sourceId, run: (id) => redactSource(ctx(), { engagementId: engA(), sourceId: id, reasonCode: "user_request" }) },
    { name: "createItem (span source)", foreign: () => B.e.sourceId, run: (id) => createItem(ctx(), { engagementId: engA(), kind: "constraint", statement: "x", spans: [{ sourceId: id, quote: QUOTE }] }) },
    { name: "runExtraction (source)", foreign: () => B.e.sourceId, run: (id) => runExtraction({ db: app.db, orgId: A.e.orgId, userId: A.e.userId, engagementId: engA(), sourceId: id, clock, modelClientFactory: () => new MockModelClient() }) },
    // Contact ids
    { name: "eraseContact", foreign: () => B.contactId, run: (id) => eraseContact(ctx(), { engagementId: engA(), contactId: id }) },
    { name: "updateContact", foreign: () => B.contactId, run: (id) => updateContact(ctx(), { engagementId: engA(), contactId: id, name: "Renamed" }) },
    { name: "requestConfirmation (contact)", foreign: () => B.contactId, run: (id) => requestConfirmation(ctx(), { engagementId: engA(), items: [{ itemId: A.requirementId }], contactIds: [id] }) },
    // Request ids (and the contact behind them)
    { name: "revokeConfirmation", foreign: () => B.requestId, run: (id) => revokeConfirmation(ctx(), { engagementId: engA(), requestId: id }) },
    {
      name: "recordAuthorization",
      foreign: () => B.requestId,
      run: (id) => recordAuthorization(client(), { engagementId: engA(), requestId: id, contactId: A.contactId, decision: "granted", text: "I authorize.", textVersion: AUTHORIZATION_TEXT_VERSION, evidence: { ip: null, userAgent: null } }),
    },
    {
      name: "recordClientResponses (contact)",
      foreign: () => B.contactId,
      run: (id) =>
        recordClientResponses(client(), {
          channel: "email_link",
          engagementId: engA(),
          requestId: B.requestId,
          contactId: id,
          submissionId: randomUUID(),
          responses: [{ itemId: B.itemId, version: 1, contentHash: "a".repeat(64), decision: "confirmed" }],
          evidence: { ip: null, userAgent: null },
        }),
      notFound: false,
    },
    // Candidate ids
    { name: "acceptCandidate", foreign: () => B.candidateId, run: (id) => acceptCandidate(ctx(), { candidateId: id }) },
    { name: "rejectCandidate", foreign: () => B.candidateId, run: (id) => rejectCandidate(ctx(), { candidateId: id }) },
    // API token and user ids
    { name: "revokeApiToken", foreign: () => B.apiTokenId, run: (id) => revokeApiToken({ db: app.db, ctx: auth(), clock, tokenId: id }) },
    { name: "deactivateUser", foreign: () => B.memberId, run: (id) => deactivateUser({ db: app.db, ctx: auth(), clock, userId: id }) },
    { name: "getCurrentUser (forged context)", foreign: () => B.memberId, run: (id) => getCurrentUser(app.db, { orgId: A.e.orgId, userId: id, role: "member" }) },
  ];

  it.each(cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const foreign = await outcome(c.run(c.foreign()));
    const unknown = await outcome(c.run(randomUUID()));
    expect(foreign).toBe(unknown);
    expect(foreign).not.toMatch(/^(resolved|unexpected)/);
    if (c.notFound !== false) expect(foreign.split(":")[1]).toMatch(NOT_FOUND);
  });

  it("link and notification writes with org B's ids change nothing", async () => {
    const forged: ClientLinkContext = { ...B.link, orgId: A.e.orgId };
    await recordLinkOpen({ db: app.db, link: forged, clock });
    await recordLinkInteraction({ db: app.db, link: forged, clock });
    await withTenant(app.db, { orgId: A.e.orgId }, async (tx) => {
      expect(await markRead(tx, A.e.userId, [B.notificationId], new Date())).toBe(0);
      expect(await markRead(tx, B.e.userId, [B.notificationId], new Date())).toBe(0);
      expect(await markAllRead(tx, B.e.userId, new Date())).toBe(0);
    });
  });
});

describe("cross-tenant queries: org B's ids read as missing", () => {
  const inA = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app.db, { orgId: A.e.orgId, userId: A.e.userId }, fn);
  const now = () => new Date();

  const cases: [string, (tx: Tx) => Promise<unknown>, unknown][] = [
    ["getEngagementSummary", (tx) => getEngagementSummary(tx, B.e.engagementId), null],
    ["listItems", (tx) => listItems(tx, B.e.engagementId, { lifecycle: ["active", "superseded", "withdrawn"] }), []],
    ["getItemDetail (B engagement)", (tx) => getItemDetail(tx, B.e.engagementId, B.itemId), null],
    ["getItemDetail (A engagement, B item)", (tx) => getItemDetail(tx, A.e.engagementId, B.itemId), null],
    ["listSources", (tx) => listSources(tx, B.e.engagementId), []],
    ["getSourceDetail (B engagement)", (tx) => getSourceDetail(tx, B.e.engagementId, B.e.sourceId), null],
    ["getSourceDetail (A engagement, B source)", (tx) => getSourceDetail(tx, A.e.engagementId, B.e.sourceId), null],
    ["listContacts", (tx) => listContacts(tx, B.e.engagementId), []],
    ["listConfirmationRequests", (tx) => listConfirmationRequests(tx, B.e.engagementId, { now: now() }), []],
    ["listConfirmationRequests (A engagement, B request)", (tx) => listConfirmationRequests(tx, A.e.engagementId, { now: now(), requestId: B.requestId }), []],
    ["loadDeliveryContext", (tx) => loadDeliveryContext(tx, B.requestId, [B.link.linkId]), null],
    ["listOpenDisputes", (tx) => listOpenDisputes(tx, B.e.engagementId), []],
    ["listCandidates", (tx) => listCandidates(tx, B.e.engagementId), []],
    ["listExtractionRuns", (tx) => listExtractionRuns(tx, B.e.engagementId), []],
    ["listExtractionRuns (A engagement, B source)", (tx) => listExtractionRuns(tx, A.e.engagementId, { sourceId: B.e.sourceId }), []],
    ["listNotifications (B user)", (tx) => listNotifications(tx, B.e.userId), []],
    ["unreadCount (B user)", (tx) => unreadCount(tx, B.e.userId), 0],
    ["readEvents", (tx) => readEvents(tx, B.e.engagementId), []],
    ["readEngagementHead", (tx) => readEngagementHead(tx, B.e.engagementId), null],
    ["loadState", async (tx) => (await loadState(tx, B.e.engagementId)).engagement, null],
    ["dumpProjections", async (tx) => Object.values(await dumpProjections(tx, B.e.engagementId)).flat(), []],
    ["loadEngagementMetrics", (tx) => loadEngagementMetrics(tx, B.e.engagementId, now()), null],
  ];

  it.each(cases)("%s", async (_name, run, expected) => {
    expect(await inA(run)).toEqual(expected);
  });

  it("org-wide lists, metrics and the CSV contain only org A's rows", async () => {
    await inA(async (tx) => {
      expect((await listEngagements(tx)).map((e) => e.id)).toEqual([A.e.engagementId]);
      expect((await loadOrgMetrics(tx, now())).engagements.map((e) => e.engagementId)).toEqual([A.e.engagementId]);
      expect((await buildMetricsCsv(tx, now())).body).not.toContain(B.e.engagementId);
    });
    const auth = { orgId: A.e.orgId, userId: A.e.userId, role: "admin" as const };
    expect((await listApiTokens(app.db, auth)).map((t) => t.id)).not.toContain(B.apiTokenId);
    expect((await listUsers(app.db, auth)).map((u) => u.id)).not.toContain(B.memberId);
  });
});

describe("org B after every attempt", () => {
  it("is unchanged: every row of every tenant table, the log head and the projections", async () => {
    // Runs last in this file (Vitest runs a file's tests in order).
    for (const table of ["event", "item", "source_content", "contact_pii", "confirmation_link", "candidate", "notification", "api_token", "app_user", "audit_log"]) {
      expect(before[table]?.length, table).toBeGreaterThan(0);
    }
    expect(await orgSnapshot(B.e.orgId)).toEqual(before);
    await withTenant(app.db, { orgId: B.e.orgId }, async (tx) => {
      const head = await readEngagementHead(tx, B.e.engagementId);
      expect(head?.seq).toBe((await readEvents(tx, B.e.engagementId)).length);
    });
  });
});
