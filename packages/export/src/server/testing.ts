// Test helpers (`@veradact/export/server/testing`): an engagement built through the real core
// commands with a controllable fake clock. Synthetic data and fictional companies only. Tests run
// in parallel against one database, so every scenario creates its own org.
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
  type CommandContext,
  type ItemVersionResult,
} from "@veradact/core";
import { event, type Db, type DbHandle, type Tx } from "@veradact/db";
import { createTestOrg, createTestUser } from "@veradact/db/testing";

/** Steps `stepMs` per read; `jump(to)` moves it forward (never backward). */
export interface ControllableClock {
  clock: () => Date;
  jump(to: Date): void;
}

export function controllableClock(start: Date, stepMs = 1000): ControllableClock {
  let t = start.getTime();
  return {
    clock: () => {
      const now = new Date(t);
      t += stepMs;
      return now;
    },
    jump: (to) => {
      t = Math.max(t, to.getTime());
    },
  };
}

export const SCENARIO_NOTES = [
  "Kickoff call, Halvorsen Freight.",
  "Dana: The dispatch dashboard must refresh every five minutes.",
  "Lee: Invoices are exported nightly to the carrier portal.",
  "Dana: We assume carriers accept CSV uploads.",
  "Lee: Use the existing SSO provider for staff logins.",
  "",
].join("\n");

export const SCENARIO_START = new Date("2026-03-02T15:00:00.000Z");
/** Ada and Ben confirm R1. */
export const FIRST_RESPONSES_AT = new Date("2026-03-03T15:00:00.000Z");
/** Ada confirms D1 and disputes A1. */
export const LATER_RESPONSES_AT = new Date("2026-03-10T15:00:00.000Z");
export const SCENARIO_TIME_ZONE = "America/New_York";
export const DISPUTE_COMMENT = "We have not checked this with the carriers yet.";
const EVIDENCE = { ip: "192.0.2.10", userAgent: "Mozilla/5.0 (synthetic)" };
const AUTH_TEXT = "I authorize the vendor to record my confirmations for Dispatch portal rebuild.";

export interface ScenarioItem {
  itemId: string;
  shortId: string;
  contentHash: string;
  statement: string;
  /** The cited quote (null for manual items). */
  quote: string | null;
}

export interface ExportScenario {
  orgId: string;
  userId: string;
  engagementId: string;
  shortCode: string;
  sourceId: string;
  ctx: CommandContext & { db: Db };
  clock: ControllableClock;
  contacts: { ada: string; ben: string };
  /** r1 confirmed (Ada + Ben, day 1); d1 confirmed (Ada, day 8); r2 pending (requested); a1 disputed (Ada, day 8); c1 manual, never requested. */
  items: { r1: ScenarioItem; d1: ScenarioItem; r2: ScenarioItem; a1: ScenarioItem; c1: ScenarioItem };
}

export interface ExportScenarioOptions {
  orgAiEnabled?: boolean;
  engagementAiEnabled?: boolean;
  shortCode?: string;
}

function scenarioItem(result: ItemVersionResult, statement: string, quote: string | null): ScenarioItem {
  return { itemId: result.itemId, shortId: result.shortId, contentHash: result.contentHash, statement, quote };
}

/** Org (admin connection) + member, then everything else through the commands on the app role. */
export async function createExportScenario(app: DbHandle, admin: Db, options: ExportScenarioOptions = {}): Promise<ExportScenario> {
  const testOrg = await createTestOrg(admin, { aiEnabled: options.orgAiEnabled ?? true });
  const user = await createTestUser(admin, { orgId: testOrg.id, name: "Alex Member" });
  const clock = controllableClock(SCENARIO_START);
  const ctx = { db: app.db, orgId: testOrg.id, userId: user.id, clock: clock.clock };
  const shortCode = options.shortCode ?? "HALV";

  const { engagementId } = await createEngagement(ctx, {
    name: "Dispatch portal rebuild",
    clientName: "Halvorsen Freight",
    shortCode,
    timeZone: SCENARIO_TIME_ZONE,
    aiEnabled: options.engagementAiEnabled ?? true,
  });
  const { sourceId } = await ingestSource(ctx, {
    engagementId,
    parsed: { text: SCENARIO_NOTES, rawText: SCENARIO_NOTES, segments: [] },
    title: "Kickoff notes",
    filename: "kickoff.md",
    format: "md",
    sourceType: "human_notes",
    occurredAt: new Date("2026-02-20T14:00:00.000Z"),
    participants: ["Dana", "Lee"],
    attestation: { allParticipantsConsented: null, jurisdictions: [], jurisdictionsKnown: false },
  });

  const sourced = async (kind: "requirement" | "decision" | "assumption", statement: string, quote: string) =>
    scenarioItem(await createItem(ctx, { engagementId, kind, statement, spans: [{ sourceId, quote }] }), statement, quote);
  const r1 = await sourced("requirement", "The dispatch dashboard refreshes every five minutes.", "The dispatch dashboard must refresh every five minutes.");
  const d1 = await sourced("decision", "Staff sign in through the existing SSO provider.", "Use the existing SSO provider for staff logins.");
  const r2 = await sourced("requirement", "Invoices go to the carrier portal every night.", "Invoices are exported nightly to the carrier portal.");
  const a1 = await sourced("assumption", "Carriers can upload CSV files.", "We assume carriers accept CSV uploads.");
  const c1Statement = "Route changes are approved within 48 hours.";
  const c1 = scenarioItem(await createItem(ctx, { engagementId, kind: "constraint", statement: c1Statement, manual: true }), c1Statement, null);

  const ada = (await addContact(ctx, { engagementId, name: "Ada Client", email: "ada@client.example" })).contactId;
  const ben = (await addContact(ctx, { engagementId, name: "Ben Client", email: "ben@client.example" })).contactId;
  const { requestId } = await requestConfirmation(ctx, {
    engagementId,
    items: [r1, d1, r2, a1].map((i) => ({ itemId: i.itemId, version: 1, contentHash: i.contentHash })),
    contactIds: [ada, ben],
  });

  const client = { db: app.db, orgId: testOrg.id, clock: clock.clock };
  for (const contactId of [ada, ben]) {
    await recordAuthorization(client, { engagementId, requestId, contactId, decision: "granted", text: AUTH_TEXT, textVersion: AUTHORIZATION_TEXT_VERSION, evidence: EVIDENCE });
  }
  const respond = (contactId: string, responses: { item: ScenarioItem; decision: "confirmed" | "disputed"; comment?: string }[]) =>
    recordClientResponses(client, {
      channel: "email_link",
      engagementId,
      requestId,
      contactId,
      submissionId: randomUUID(),
      responses: responses.map((r) => ({ itemId: r.item.itemId, version: 1, contentHash: r.item.contentHash, decision: r.decision, comment: r.comment ?? null })),
      evidence: EVIDENCE,
    });

  clock.jump(FIRST_RESPONSES_AT);
  await respond(ada, [{ item: r1, decision: "confirmed" }]);
  await respond(ben, [{ item: r1, decision: "confirmed" }]);
  clock.jump(LATER_RESPONSES_AT);
  await respond(ada, [
    { item: d1, decision: "confirmed" },
    { item: a1, decision: "disputed", comment: DISPUTE_COMMENT },
  ]);

  return { orgId: testOrg.id, userId: user.id, engagementId, shortCode, sourceId, ctx, clock, contacts: { ada, ben }, items: { r1, d1, r2, a1, c1 } };
}

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Wraps a transaction so that `hook` runs once, right before or right after the first query on the
 * `event` table: the moment another connection's append can commit between this transaction's
 * statements at READ COMMITTED (used to test that loaders read `engagement_head` first).
 */
export function onFirstEventRead(tx: Tx, when: "before" | "after", hook: () => Promise<void>): Tx {
  let fired = false;
  const wrap = (builder: object): object =>
    new Proxy(builder, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== "function") return value;
        if (prop === "then") {
          return (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
            (async () => {
              const fire = !fired;
              fired = true;
              if (fire && when === "before") await hook();
              const rows = await new Promise((res, rej) => (value as AnyFn).call(target, res, rej));
              if (fire && when === "after") await hook();
              return rows;
            })().then(resolve, reject);
        }
        return (...args: unknown[]) => {
          const result = (value as AnyFn).apply(target, args);
          return result === target ? wrap(target) : result;
        };
      },
    });
  return new Proxy(tx, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      if (prop !== "select") return (value as AnyFn).bind(target);
      return (...args: unknown[]) => {
        const builder = (value as AnyFn).apply(target, args) as object;
        return new Proxy(builder, {
          get(b, p) {
            const v = Reflect.get(b, p, b) as unknown;
            if (typeof v !== "function") return v;
            if (p === "from") {
              return (table: unknown, ...rest: unknown[]) => {
                const query = (v as AnyFn).call(b, table, ...rest) as object;
                return table === event ? wrap(query) : query;
              };
            }
            return (v as AnyFn).bind(b);
          },
        });
      };
    },
  });
}
