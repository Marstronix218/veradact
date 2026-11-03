// The demo seed (`pnpm seed`): a fictional vendor org (Quillfield Labs) and its engagement with a
// fictional client (Halvorsen Freight, HALV), built from fixtures/seed through the real commands,
// so RLS, triggers, the hash chain and every validation apply exactly as in the app.
//
// - The admin connection is used for one thing only: creating the org and its two users (orgs are
//   created by an operator, D-030). Everything else runs on the app role inside withTenant.
// - A stepping fake clock replays a plausible history from Sept 1 to Oct 27, 2026 (all wall times
//   below are America/New_York). Each clock read advances one second; `clock.at()` jumps forward.
// - Fixture → ledger mapping (DECISIONS D-053):
//   * Items from machine transcripts (kickoff, scope call) are accepted extraction candidates:
//     `provenance = { via: 'ai_candidate', model: 'fixture', prompt_version: 'extract.v1' }` with a
//     fresh candidate id but no candidate row (the item detail query tolerates a missing row).
//     Items from the human-written security review notes are entered by their author (Tomás) as
//     manual-with-source items (`via: 'manual'` + a verified span). k3 and k12 are manual items.
//   * k19 (`revises: k18`, 5:30 → 5:00) is recorded as version 2 of k18's item: a revision of a
//     confirmed requirement that drops back to pending (invariant 4) and flags k16 and k23 for
//     review. So 24 fixture entries become 23 ledger items.
//   * k22 (`revises: k21`, SSO later → SSO before go-live) is a new item that supersedes k21, so the
//     demo shows both mechanisms (revision and supersession).
// - Historical confirmation requests go through the real `sendConfirmationRequest` with a channel
//   that delivers nothing (`email_sent_at` is still set): no stale emails land in Mailpit.
import { randomBytes, randomUUID } from "node:crypto";
import { TZDate } from "@date-fns/tz";
import { and, eq, isNull } from "drizzle-orm";
import { appUser, confirmationLink, getPgError, org, withTenant, type Db } from "@veradact/db";
import { detectFormat, parseSource } from "@veradact/ingest";
import {
  AUTHORIZATION_TEXT_VERSION,
  addContact,
  addDependency,
  createApiToken,
  createEngagement,
  createItem,
  currentVersionOf,
  DEMO_ORG_SLUG,
  ingestSource,
  insertNotifications,
  loadState,
  recordAuthorization,
  recordClientResponses,
  recordLinkInteraction,
  recordLinkOpen,
  renderAuthorizationText,
  reviseItem,
  seedMetricsScenario,
  sendConfirmationRequest,
  supersedeItem,
  updateEngagement,
  verifyEngagementChain,
  withdrawItem,
  type ChainVerification,
  type ClientEvidence,
  type ConfirmationChannel,
  type EngagementState,
  type ItemState,
  type ItemStatus,
  type Provenance,
} from "@veradact/core";
import { loadSeedFixtures, type FixtureItem, type FixtureSource } from "./fixtures";

/** Also the only org demo password sign-in accepts (core `DEMO_ORG_SLUG`, D-064). */
export const DEMO_SLUG = DEMO_ORG_SLUG;
export const DEMO_ORG_NAME = "Quillfield Labs";
export const DEMO_ENGAGEMENT = {
  name: "Halvorsen Freight — AI dispatch routing",
  clientName: "Halvorsen Freight",
  shortCode: "HALV",
  timeZone: "America/New_York",
} as const;
export const METRICS_ENGAGEMENT = { name: "Pilot metrics demo", shortCode: "PILOT" } as const;
/** Provenance recorded on items accepted from the (fixture) extraction of the transcripts. */
export const FIXTURE_EXTRACTION = { model: "fixture", promptVersion: "extract.v1" } as const;

const TZ = DEMO_ENGAGEMENT.timeZone;

/** Wall-clock time in the engagement time zone: `et("2026-09-08 13:30")`. */
function et(local: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(local);
  if (!match) throw new Error(`seed: bad timeline time ${local}`);
  const [, y, mo, d, h = "0", mi = "0"] = match;
  return new Date(TZDate.tz(TZ, Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)).getTime());
}

const TIMELINE_START = et("2026-09-01 09:00");
/** Just after the last scripted event; `now` is clamped to at least this. */
export const TIMELINE_END = et("2026-10-27 18:30");

/** The demo users. With the default slug: admin@quillfield.example and tomas@quillfield.example. */
export function demoUsers(slug: string) {
  return {
    admin: { email: `admin@${slug}.example`, name: "Priya Raman", role: "admin" as const },
    member: { email: `tomas@${slug}.example`, name: "Tomás Ferreira", role: "member" as const },
  };
}

/** Fixture `revises` links recorded as a new version of the same item. */
const REVISE_IN_PLACE: Readonly<Record<string, string>> = { k19: "k18" };
/** Fixture `revises` links recorded as a new item that supersedes the old one. */
const SUPERSEDES: Readonly<Record<string, string>> = { k22: "k21" };

/** Synthetic client devices (IPs from the RFC 5737 documentation ranges). */
const DEVICES: Readonly<Record<string, ClientEvidence>> = {
  "Dana Whitcombe": {
    ip: "198.51.100.23",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  },
  "Marcus Oyelaran": {
    ip: "203.0.113.41",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  },
  "Lena Sorensen": {
    ip: "198.51.100.77",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  },
};

/** What each disputing contact adds after the fixture's `followup` quote. */
const DISPUTE_CONTEXT: Readonly<Record<string, string>> = {
  k14: "At kickoff I said I could live with read-only to begin with, which is not the same thing. If dispatchers have to retype every assignment into FleetDesk, the pilot will not show the time savings. Our position: write access for assignments only, behind a feature flag, approved by my team under the integration policy.",
  k10: "They bring their own devices, so an Android-only app would leave them out.",
};

/** Records delivery without sending anything: the requests are history, not new mail. */
const NO_DELIVERY: ConfirmationChannel = { name: "email_link", deliver: async () => {} };

export class DemoOrgExistsError extends Error {
  constructor(readonly slug: string) {
    super(`an org with slug "${slug}" already exists`);
    this.name = "DemoOrgExistsError";
  }
}

export interface SeedDemoInput {
  /** Owner role: creates the org and its users, nothing else. */
  adminDb: Db;
  /** App role (RLS): all ledger and operational data. */
  appDb: Db;
  /** Default `quillfield`; user emails are derived from it (`admin@<slug>.example`). */
  slug?: string;
  /** The demo's present (API token, metrics engagement). Defaults to now; clamped to TIMELINE_END. */
  now?: Date;
}

export interface ItemSummary {
  total: number;
  /** Status of active items. */
  active: Record<ItemStatus, number>;
  superseded: number;
  withdrawn: number;
  needsReview: number;
  /** Items with a revision recorded after a confirmation of an earlier version. */
  revisedAfterConfirmation: number;
  /** Active pending items never included in a confirmation request. */
  neverSent: number;
}

export interface SeedDemoResult {
  orgId: string;
  slug: string;
  users: { admin: { id: string; email: string; name: string }; member: { id: string; email: string; name: string } };
  engagement: { id: string; shortCode: string; name: string };
  sourceIds: Record<string, string>;
  /** Fixture key → the item and version carrying that entry's statement and quote. */
  fixtureItems: Record<string, { itemId: string; shortId: string; version: number }>;
  summary: ItemSummary;
  chain: ChainVerification;
  /** The metrics engagement (`seedMetricsScenario`). */
  metrics: { engagementId: string; shortCode: string; chain: ChainVerification };
  /** Raw MCP bearer token for the admin: shown once, never stored. */
  apiToken: { id: string; token: string; tokenPrefix: string };
}

/** Stepping fake clock: each read returns the current time and advances one second. */
class DemoClock {
  #ms: number;
  constructor(start: Date) {
    this.#ms = start.getTime();
  }
  readonly now = (): Date => {
    const value = new Date(this.#ms);
    this.#ms += 1000;
    return value;
  };
  /** Jumps to `when`; the timeline may only move forward. */
  at(when: Date): void {
    if (when.getTime() < this.#ms) throw new Error(`seed: timeline goes backwards at ${when.toISOString()}`);
    this.#ms = when.getTime();
  }
}

function aiProvenance(): Provenance {
  return { via: "ai_candidate", candidate_id: randomUUID(), model: FIXTURE_EXTRACTION.model, prompt_version: FIXTURE_EXTRACTION.promptVersion, edited: false };
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

async function createDemoOrg(adminDb: Db, slug: string, createdAt: Date) {
  const users = demoUsers(slug);
  const existing = await adminDb.select({ id: org.id }).from(org).where(eq(org.slug, slug));
  if (existing.length > 0) throw new DemoOrgExistsError(slug);
  const orgId = randomUUID();
  const adminId = randomUUID();
  const memberId = randomUUID();
  try {
    await adminDb.transaction(async (tx) => {
      await tx.insert(org).values({ id: orgId, name: DEMO_ORG_NAME, slug, createdAt });
      await tx.insert(appUser).values([
        { id: adminId, orgId, ...users.admin, createdAt },
        { id: memberId, orgId, ...users.member, createdAt },
      ]);
    });
  } catch (error) {
    // Drizzle's message embeds the parameters (emails): rethrow with SQLSTATE/constraint only.
    const pg = getPgError(error);
    if (pg?.code === "23505" && pg.constraint === "org_slug_unique") throw new DemoOrgExistsError(slug);
    if (pg?.code === "23505") throw new Error(`seed: ${pg.constraint ?? "a unique constraint"} is already taken (is a demo user email registered to another org?)`);
    throw error;
  }
  return {
    orgId,
    admin: { id: adminId, email: users.admin.email, name: users.admin.name },
    member: { id: memberId, email: users.member.email, name: users.member.name },
  };
}

export function summarizeItems(state: EngagementState): ItemSummary {
  const summary: ItemSummary = {
    total: state.items.size,
    active: { pending: 0, confirmed: 0, disputed: 0 },
    superseded: 0,
    withdrawn: 0,
    needsReview: 0,
    revisedAfterConfirmation: 0,
    neverSent: 0,
  };
  const requested = new Set([...state.requests.values()].flatMap((r) => r.items.map((i) => i.itemId)));
  for (const item of state.items.values()) {
    if (item.lifecycle === "active") summary.active[item.status] += 1;
    else summary[item.lifecycle] += 1;
    if (item.needsReview) summary.needsReview += 1;
    if (isRevisedAfterConfirmation(item)) summary.revisedAfterConfirmation += 1;
    if (item.lifecycle === "active" && item.status === "pending" && !requested.has(item.id)) summary.neverSent += 1;
  }
  return summary;
}

/** A revision was recorded after a client confirmed an earlier version. */
export function isRevisedAfterConfirmation(item: ItemState): boolean {
  return item.versions.some((v) => v.version > 1 && item.responses.some((r) => r.response === "confirmed" && r.version < v.version && r.seq < v.seq));
}

/** Seeds the demo org; throws `DemoOrgExistsError` when the slug is taken (use `purgeDemoOrg`). */
export async function seedDemo(input: SeedDemoInput): Promise<SeedDemoResult> {
  const { adminDb, appDb } = input;
  const slug = input.slug ?? DEMO_SLUG;
  const present = new Date(Math.max((input.now ?? new Date()).getTime(), TIMELINE_END.getTime()));
  const fixtures = await loadSeedFixtures();
  for (const fx of fixtures.items) {
    if (fx.revises !== null && REVISE_IN_PLACE[fx.key] !== fx.revises && SUPERSEDES[fx.key] !== fx.revises) {
      throw new Error(`seed: no mapping for fixture ${fx.key} (revises ${fx.revises})`);
    }
  }
  const clock = new DemoClock(TIMELINE_START);

  // ── Tue Sept 1: the operator creates the org and its users (admin connection, D-030).
  const created = await createDemoOrg(adminDb, slug, TIMELINE_START);
  const { orgId } = created;
  const priya = { db: appDb, orgId, userId: created.admin.id, clock: clock.now };
  const tomas = { db: appDb, orgId, userId: created.member.id, clock: clock.now };
  const client = { db: appDb, orgId, clock: clock.now };

  const fixtureByKey = new Map(fixtures.items.map((i) => [i.key, i]));
  const fixtureItems: SeedDemoResult["fixtureItems"] = {};
  const itemId = (key: string): string => {
    const entry = fixtureItems[key];
    if (!entry) throw new Error(`seed: fixture item ${key} is not in the ledger yet`);
    return entry.itemId;
  };
  const fixture = (key: string): FixtureItem => {
    const fx = fixtureByKey.get(key);
    if (!fx) throw new Error(`seed: unknown fixture item ${key}`);
    return fx;
  };

  // ── Fri Sept 4: Priya opens the engagement and adds the client contacts.
  clock.at(et("2026-09-04 09:30"));
  const { engagementId } = await createEngagement(priya, { ...DEMO_ENGAGEMENT, aiEnabled: true });
  const authText = renderAuthorizationText({ vendorName: DEMO_ORG_NAME, engagementName: DEMO_ENGAGEMENT.name, clientName: DEMO_ENGAGEMENT.clientName });
  clock.at(et("2026-09-04 09:35"));
  const contactIds = new Map<string, string>();
  for (const c of fixtures.contacts) {
    const { contactId } = await addContact(priya, { engagementId, name: c.name, email: c.email, title: c.title });
    contactIds.set(c.name, contactId);
  }
  const contactId = (name: string): string => {
    const id = contactIds.get(name);
    if (!id) throw new Error("seed: unknown contact in the timeline");
    return id;
  };

  const loadEngagement = (): Promise<EngagementState> => withTenant(appDb, { orgId }, (tx) => loadState(tx, engagementId));

  // ---------------------------------------------------------------------------------------------
  // Timeline helpers

  interface Ingested {
    sourceId: string;
    text: string;
    meta: FixtureSource;
  }
  const sourceIds: Record<string, string> = {};

  /** Tomás uploads a fixture file: parseSource → ingestSource with the fixture's attestation. */
  async function ingest(filename: string, at: string, title: string): Promise<Ingested> {
    const meta = fixtures.sources.find((s) => s.filename === filename);
    if (!meta) throw new Error(`seed: missing fixture source ${filename}`);
    clock.at(et(at));
    const format = detectFormat(meta.filename, meta.bytes);
    const parsed = await parseSource({ format, bytes: meta.bytes, filename: meta.filename });
    const { sourceId } = await ingestSource(tomas, {
      engagementId,
      parsed,
      title,
      filename: meta.filename,
      format,
      sourceType: meta.type,
      occurredAt: et(meta.date), // a date-only source date is the start of that day locally (§1.1)
      participants: meta.participants.map((p) => p.name),
      attestation: { allParticipantsConsented: meta.consent_attested, jurisdictions: [meta.jurisdiction], jurisdictionsKnown: true },
    });
    sourceIds[filename] = sourceId;
    return { sourceId, text: parsed.text, meta };
  }

  /**
   * Tomás records the source's items in the order their quotes appear: accepted extraction
   * candidates for transcripts, manual-with-source entries for his own notes. Dependencies on
   * earlier items of the same source go in at creation (like a candidate's suggestion); any other
   * dependency is added by Priya afterwards with `addDependency`.
   */
  async function recordSourceItems(source: Ingested, startAt: string, dependenciesAt: string): Promise<void> {
    const extracted = source.meta.type === "machine_transcript";
    const position = (fx: FixtureItem): number => {
      const index = source.text.indexOf(fx.quote ?? "");
      if (index < 0) throw new Error(`seed: quote of ${fx.key} is not in its source`);
      return index;
    };
    const entries = fixtures.items.filter((i) => i.source === source.meta.filename).sort((a, b) => position(a) - position(b));
    const deferred: [string, string][] = [];
    let at = et(startAt);
    for (const fx of entries) {
      clock.at(at);
      at = addMinutes(at, extracted ? 1 : 2);
      const span = { sourceId: source.sourceId, quote: fx.quote! };
      const provenance = extracted ? { provenance: aiProvenance() } : {};
      const revised = REVISE_IN_PLACE[fx.key];
      if (revised) {
        const target = (await loadEngagement()).items.get(itemId(revised))!;
        const current = currentVersionOf(target);
        // As `acceptCandidate` does for a revision candidate (D-050): every current span is
        // replaced by the candidate's verified span, reason `new_information`.
        const result = await reviseItem(tomas, {
          engagementId,
          itemId: target.id,
          statement: fx.statement,
          reasonCode: "new_information",
          removeSpans: current.spans.map((s) => ({ sourceId: s.source_id, start: s.start, end: s.end })),
          addSpans: [span],
          expectedVersion: current.version,
          ...provenance,
        });
        fixtureItems[fx.key] = { itemId: target.id, shortId: target.shortId, version: result.version };
        continue;
      }
      const dependsOn: string[] = [];
      for (const up of fx.depends_on) {
        if (fixtureItems[up] && fixture(up).source === fx.source) dependsOn.push(itemId(up));
        else deferred.push([fx.key, up]);
      }
      const result = await createItem(tomas, { engagementId, kind: fx.kind, statement: fx.statement, spans: [span], dependsOn, ...provenance });
      fixtureItems[fx.key] = { itemId: result.itemId, shortId: result.shortId, version: 1 };
    }
    if (deferred.length > 0) clock.at(et(dependenciesAt));
    for (const [key, up] of deferred) await addDependency(priya, { engagementId, itemId: itemId(key), dependsOnItemId: itemId(up) });
  }

  interface Link {
    contact: string;
    contactId: string;
    linkId: string;
    requestId: string;
  }
  const signingSecret = randomBytes(32).toString("base64url"); // tokens of undelivered links are discarded
  const appUrl = process.env.APP_URL ?? "http://localhost:3000";

  /** Priya sends a confirmation request; returns each contact's link. */
  async function send(at: string, keys: string[], contacts: string[]): Promise<Map<string, Link>> {
    clock.at(et(at));
    const result = await sendConfirmationRequest(priya, {
      engagementId,
      items: keys.map((k) => ({ itemId: itemId(k) })),
      contactIds: contacts.map(contactId),
      appUrl,
      channel: NO_DELIVERY,
      signingSecret,
    });
    if (result.failedCount > 0) throw new Error("seed: a confirmation link was not marked as sent");
    const links = new Map<string, Link>();
    for (const name of contacts) {
      const delivery = result.deliveries.find((d) => d.contactId === contactId(name))!;
      links.set(name, { contact: name, contactId: delivery.contactId, linkId: delivery.linkId, requestId: result.requestId });
    }
    return links;
  }

  const linkHandle = (link: Link) => ({
    db: appDb,
    clock: clock.now,
    link: { orgId, engagementId, requestId: link.requestId, contactId: link.contactId, linkId: link.linkId },
  });

  /** GET of the client page (raw open counter). */
  async function open(link: Link, at: string): Promise<void> {
    clock.at(et(at));
    await recordLinkOpen(linkHandle(link));
  }

  /** The contact grants the written authorization (their first POST on the link). */
  async function authorize(link: Link, at: string): Promise<void> {
    clock.at(et(at));
    await recordLinkInteraction(linkHandle(link));
    await recordAuthorization(client, {
      engagementId,
      requestId: link.requestId,
      contactId: link.contactId,
      decision: "granted",
      text: authText,
      textVersion: AUTHORIZATION_TEXT_VERSION,
      evidence: DEVICES[link.contact]!,
    });
  }

  /**
   * One client submission for the items' current versions. Disputes carry the fixture's followup
   * quote plus context, and notify the member who sent the request (as the client page does).
   */
  async function respond(link: Link, at: string, responses: { key: string; decision: "confirmed" | "disputed" }[]): Promise<void> {
    clock.at(et(at));
    await recordLinkInteraction(linkHandle(link));
    await withTenant(appDb, { orgId }, async (tx) => {
      const state = await loadState(tx, engagementId);
      const result = await recordClientResponses(
        { tx, orgId, clock: clock.now },
        {
          channel: "email_link",
          engagementId,
          requestId: link.requestId,
          contactId: link.contactId,
          submissionId: randomUUID(),
          evidence: DEVICES[link.contact]!,
          responses: responses.map(({ key, decision }) => {
            const current = currentVersionOf(state.items.get(itemId(key))!);
            const followup = fixture(key).followup;
            const comment = decision === "disputed" ? `${followup?.quote ?? "This is not what we agreed"}. ${DISPUTE_CONTEXT[key] ?? ""}`.trim() : null;
            return { itemId: itemId(key), version: current.version, contentHash: current.contentHash, decision, comment };
          }),
        },
      );
      const requestedBy = result.state.requests.get(link.requestId)?.requestedBy ?? null;
      const disputed = responses.filter((r) => r.decision === "disputed");
      if (requestedBy && disputed.length > 0) {
        await insertNotifications(
          tx,
          disputed.map((r) => ({
            orgId,
            userId: requestedBy,
            engagementId,
            kind: "item_disputed" as const,
            itemId: itemId(r.key),
            contactId: link.contactId,
            createdAt: result.events[0]!.recordedAt,
          })),
        );
      }
    });
  }

  /** What `runReminders` (§8.6) did at `at` for this link: one reminder, recorded once. */
  async function reminderSent(link: Link, at: string): Promise<void> {
    clock.at(et(at));
    const sentAt = clock.now();
    await withTenant(appDb, { orgId }, (tx) =>
      tx
        .update(confirmationLink)
        .set({ reminderSentAt: sentAt })
        .where(and(eq(confirmationLink.id, link.linkId), isNull(confirmationLink.reminderSentAt))),
    );
  }

  const confirm = (...keys: string[]) => keys.map((key) => ({ key, decision: "confirmed" as const }));
  const dispute = (key: string) => [{ key, decision: "disputed" as const }];

  // ---------------------------------------------------------------------------------------------
  // The timeline

  // ── Tue Sept 8: kickoff call. Tomás uploads the transcript and accepts the extracted items.
  const kickoff = await ingest("01-kickoff.vtt", "2026-09-08 13:30", "Kickoff call");
  await recordSourceItems(kickoff, "2026-09-08 14:00", "2026-09-08 14:30");

  // ── Wed Sept 9: Priya enters two items no source covers, then sends each contact their items.
  let manualAt = et("2026-09-09 09:15");
  for (const fx of fixtures.items.filter((i) => i.source === null)) {
    clock.at(manualAt);
    manualAt = addMinutes(manualAt, 5);
    const result = await createItem(priya, { engagementId, kind: fx.kind, statement: fx.statement, manual: true, occurredAt: et("2026-09-09") });
    fixtureItems[fx.key] = { itemId: result.itemId, shortId: result.shortId, version: 1 };
  }
  const dana = (await send("2026-09-09 10:00", ["k1", "k2", "k13", "k20"], ["Dana Whitcombe"])).get("Dana Whitcombe")!;
  const marcus = (await send("2026-09-09 10:02", ["k4", "k5", "k6", "k9", "k14", "k21"], ["Marcus Oyelaran"])).get("Marcus Oyelaran")!;
  const lena = (await send("2026-09-09 10:04", ["k7", "k10", "k11", "k16", "k17", "k18", "k23"], ["Lena Sorensen"])).get("Lena Sorensen")!;
  await open(marcus, "2026-09-09 10:06"); // a mail scanner prefetches the link
  await open(dana, "2026-09-09 13:40");
  await authorize(dana, "2026-09-09 13:42");
  await respond(dana, "2026-09-09 13:46", confirm("k1", "k2", "k13", "k20"));

  // ── Thu Sept 10: Marcus confirms everything except the read-only decision, which he skips.
  await open(marcus, "2026-09-10 08:50");
  await authorize(marcus, "2026-09-10 08:52");
  await respond(marcus, "2026-09-10 08:58", confirm("k4", "k5", "k6", "k9", "k21"));

  // ── Fri Sept 11: Lena has not responded after two business days → the one reminder; she responds.
  await reminderSent(lena, "2026-09-11 11:00");
  await open(lena, "2026-09-11 15:20");
  await authorize(lena, "2026-09-11 15:22");
  await respond(lena, "2026-09-11 15:31", confirm("k7", "k10", "k11", "k16", "k17", "k18", "k23"));

  // ── Tue Sept 15: security review. Tomás uploads his notes and enters their items himself.
  const security = await ingest("02-security-review.md", "2026-09-15 17:30", "Security and compliance review notes");
  await recordSourceItems(security, "2026-09-15 17:40", "2026-09-15 17:50");

  // ── Wed Sept 16: SSO is now required before go-live: the new item supersedes the kickoff one.
  clock.at(et("2026-09-16 09:10"));
  for (const [newKey, oldKey] of Object.entries(SUPERSEDES)) {
    await supersedeItem(priya, {
      engagementId,
      itemId: itemId(oldKey),
      supersededByItemId: itemId(newKey),
      reasonCode: "new_information",
      note: "Security review (2026-09-15): Halvorsen Security will not sign off on go-live with local accounts.",
    });
  }
  const marcus2 = (await send("2026-09-16 09:30", ["k8", "k22"], ["Marcus Oyelaran"])).get("Marcus Oyelaran")!;
  await open(marcus2, "2026-09-16 16:05");
  await respond(marcus2, "2026-09-16 16:07", confirm("k8", "k22"));

  // ── Tue Sept 22: scope call. 5:30 → 5:00 revises a confirmed requirement (back to pending, k16 and
  // k23 need review); driver pins and the polling decision are new; Dayton is withdrawn; Marcus and
  // Lena dispute read-only access and Android-only on their still-valid links.
  const scope = await ingest("03-scope-call.srt", "2026-09-22 12:30", "Scope check call");
  await recordSourceItems(scope, "2026-09-22 13:00", "2026-09-22 13:10");
  clock.at(et("2026-09-22 13:15"));
  const dayton = fixture("k11");
  await withdrawItem(priya, {
    engagementId,
    itemId: itemId("k11"),
    reasonCode: "out_of_scope",
    note: `Retracted on the scope call (2026-09-22): "${dayton.followup?.quote ?? ""}"`,
  });
  await open(marcus, "2026-09-22 15:40");
  await respond(marcus, "2026-09-22 15:43", dispute("k14"));
  await open(lena, "2026-09-22 16:10");
  await respond(lena, "2026-09-22 16:12", dispute("k10"));

  // ── Tue Oct 27: once the earlier planning run is costed, Priya sends the revised requirement to
  // Lena and Dana. Lena opens it the same evening; nobody has answered yet (a reminder becomes due
  // on Oct 29, so `pnpm jobs:run` sends one).
  const revised = await send("2026-10-27 10:00", ["k18"], ["Lena Sorensen", "Dana Whitcombe"]);
  await open(revised.get("Lena Sorensen")!, "2026-10-27 18:20");

  for (const fx of fixtures.items) {
    if (!fixtureItems[fx.key]) throw new Error(`seed: fixture item ${fx.key} was not recorded`);
  }

  // ---------------------------------------------------------------------------------------------
  // Second engagement for the metrics page (Phase 3 seam: `seedMetricsScenario` in
  // core/metrics-queries). Replays a deterministic scenario before `present`, then renames it.
  const seeded = await withTenant(appDb, { orgId, userId: created.admin.id }, async (tx) => {
    const scenario = await seedMetricsScenario(tx, { orgId, userId: created.admin.id, now: present, shortCode: METRICS_ENGAGEMENT.shortCode });
    await updateEngagement(
      { tx, orgId, userId: created.admin.id, clock: () => new Date(present.getTime()) },
      { engagementId: scenario.engagementId, name: METRICS_ENGAGEMENT.name },
    );
    return scenario;
  });

  const apiToken = await createApiToken({
    db: appDb,
    ctx: { orgId, userId: created.admin.id, role: "admin" },
    clock: () => new Date(present.getTime()),
    name: "Demo MCP token (seed)",
  });

  const final = await withTenant(appDb, { orgId }, async (tx) => ({
    state: await loadState(tx, engagementId),
    chain: await verifyEngagementChain(tx, engagementId),
    metricsChain: await verifyEngagementChain(tx, seeded.engagementId),
  }));

  return {
    orgId,
    slug,
    users: { admin: created.admin, member: created.member },
    engagement: { id: engagementId, shortCode: DEMO_ENGAGEMENT.shortCode, name: DEMO_ENGAGEMENT.name },
    sourceIds,
    fixtureItems,
    summary: summarizeItems(final.state),
    chain: final.chain,
    metrics: { engagementId: seeded.engagementId, shortCode: seeded.shortCode, chain: final.metricsChain },
    apiToken: { id: apiToken.id, token: apiToken.token, tokenPrefix: apiToken.tokenPrefix },
  };
}
