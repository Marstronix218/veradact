// E2E fixture for the replay and export screens: an engagement whose history lies in the past,
// built with the real core commands on the app role (DATABASE_URL, RLS enforced) and a stepping
// fake clock that jumps forward between days. Synthetic data and fictional companies only.
import { randomUUID } from "node:crypto";
import {
  addContact,
  AUTHORIZATION_TEXT_VERSION,
  createEngagement,
  createItem,
  ingestSource,
  recordAuthorization,
  recordClientResponses,
  requestConfirmation,
  reviseItem,
} from "@veradact/core";
import { createDb, type DbHandle } from "@veradact/db";

let app: DbHandle | undefined;

function appDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (root .env)");
  app ??= createDb(url, { max: 2 });
  return app.db;
}

/** Close the pool in `test.afterAll`. */
export async function closeReplayDb(): Promise<void> {
  await app?.close();
  app = undefined;
}

const NOTES = [
  "Kickoff call, Halvorsen Freight dispatch rollout.",
  "Dana: The dispatch board must refresh every five minutes.",
  "Lee: Invoices are exported nightly to the carrier portal.",
  "Dana: We assume carriers accept CSV uploads.",
  "Lee: Use the existing SSO provider for staff logins.",
  "",
].join("\n");

const EVIDENCE = { ip: "192.0.2.44", userAgent: "Mozilla/5.0 (synthetic e2e)" };

export interface ReplayHistory {
  engagementId: string;
  shortCode: string;
  /** Short ids: r1 confirmed Mar 5 then revised Mar 10; d1 confirmed Mar 5 (depends on a1); a1 disputed Mar 5; r2 never answered. */
  ids: { r1: string; r2: string; a1: string; d1: string };
  statements: { r1v1: string; r1v2: string; d1: string };
}

/**
 * America/New_York, 2026:
 * - Mar 2: engagement, notes, R1, R2, A1, D1 (depends on A1); request to Ada; Ada authorizes.
 * - Mar 5: Ada confirms R1 and D1, disputes A1.
 * - Mar 10: R1 revised to version 2 (pending again).
 */
export async function createReplayHistory(tenant: { orgId: string; userId: string }): Promise<ReplayHistory> {
  let t = new Date("2026-03-02T15:00:00.000Z").getTime();
  const clock = () => {
    const now = new Date(t);
    t += 1000;
    return now;
  };
  const jump = (iso: string) => {
    t = Math.max(t, new Date(iso).getTime());
  };
  const ctx = { db: appDb(), orgId: tenant.orgId, userId: tenant.userId, clock };
  const client = { db: appDb(), orgId: tenant.orgId, clock };
  const shortCode = "HALV";

  const { engagementId } = await createEngagement(ctx, { name: "Dispatch rollout", clientName: "Halvorsen Freight", shortCode, timeZone: "America/New_York" });
  const { sourceId } = await ingestSource(ctx, {
    engagementId,
    parsed: { text: NOTES, rawText: NOTES, segments: [] },
    title: "Kickoff notes",
    filename: "kickoff.md",
    format: "md",
    sourceType: "human_notes",
    occurredAt: new Date("2026-02-27T15:00:00.000Z"),
    participants: ["Dana", "Lee"],
    attestation: { allParticipantsConsented: null, jurisdictions: [], jurisdictionsKnown: false },
  });
  const statements = {
    r1v1: "The dispatch board refreshes every five minutes.",
    r1v2: "The dispatch board refreshes every two minutes.",
    d1: "Staff sign in through the existing SSO provider.",
  };
  const r1 = await createItem(ctx, { engagementId, kind: "requirement", statement: statements.r1v1, spans: [{ sourceId, quote: "The dispatch board must refresh every five minutes." }] });
  const r2 = await createItem(ctx, {
    engagementId,
    kind: "requirement",
    statement: "Invoices are exported nightly to the carrier portal.",
    spans: [{ sourceId, quote: "Invoices are exported nightly to the carrier portal." }],
  });
  const a1 = await createItem(ctx, { engagementId, kind: "assumption", statement: "Carriers accept CSV uploads.", spans: [{ sourceId, quote: "We assume carriers accept CSV uploads." }] });
  const d1 = await createItem(ctx, {
    engagementId,
    kind: "decision",
    statement: statements.d1,
    spans: [{ sourceId, quote: "Use the existing SSO provider for staff logins." }],
    dependsOn: [a1.itemId],
  });
  const { contactId } = await addContact(ctx, { engagementId, name: "Ada Client", email: `e2e-replay-${randomUUID().slice(0, 8)}@example.test` });
  const { requestId } = await requestConfirmation(ctx, { engagementId, items: [r1, r2, a1, d1].map((i) => ({ itemId: i.itemId })), contactIds: [contactId] });
  await recordAuthorization(client, { engagementId, requestId, contactId, decision: "granted", text: "I authorize Veradact to record my responses.", textVersion: AUTHORIZATION_TEXT_VERSION, evidence: EVIDENCE });

  jump("2026-03-05T15:00:00.000Z");
  await recordClientResponses(client, {
    channel: "email_link",
    engagementId,
    requestId,
    contactId,
    submissionId: randomUUID(),
    responses: [
      { itemId: r1.itemId, version: 1, contentHash: r1.contentHash, decision: "confirmed" },
      { itemId: d1.itemId, version: 1, contentHash: d1.contentHash, decision: "confirmed" },
      { itemId: a1.itemId, version: 1, contentHash: a1.contentHash, decision: "disputed", comment: "We have not checked this with the carriers." },
    ],
    evidence: EVIDENCE,
  });

  jump("2026-03-10T14:00:00.000Z");
  await reviseItem(ctx, { engagementId, itemId: r1.itemId, statement: statements.r1v2, reasonCode: "scope_change" });

  return { engagementId, shortCode, ids: { r1: r1.shortId, r2: r2.shortId, a1: a1.shortId, d1: d1.shortId }, statements };
}
