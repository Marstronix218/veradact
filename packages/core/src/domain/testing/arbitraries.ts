/**
 * fast-check arbitraries that generate VALID event sequences for one engagement, plus helpers to
 * chain drafts into StoredEvents with a fake clock. Test-only (fast-check is a dev dependency):
 * import from `@veradact/core/testing` or this file, never from production code.
 *
 * How it works: fast-check generates a list of abstract operations (op tag + random numbers +
 * words + clock step). A deterministic builder interprets them against its own small model of the
 * engagement and emits only drafts that a correct command layer would accept; inapplicable ops are
 * skipped. Validity rules honoured:
 * - `engagement_created` is seq 1; a first source is ingested right after it.
 * - Items are created before being revised, superseded, withdrawn, requested or responded to;
 *   short ids are allocated per kind; content hashes are computed with `itemContentHash`.
 * - Every version is sourced (spans into ingested, unredacted sources) XOR manual; revisions carry
 *   some spans unchanged, may add new ones, and fall back to manual when none remain.
 * - Dependencies only from active decisions/requirements to other active items, no duplicates, no
 *   cycles. Lifecycle changes only on active items; supersede targets another active item.
 * - Requests contain active pending/disputed items at their current version and non-erased contacts.
 * - Responses only from non-erased contacts whose latest authorization is granted, on unrevoked,
 *   unexpired requests that include them, for items still active at the requested version; one
 *   submission per op (several events in the same millisecond) with a fresh submission id.
 * - Authorizations are per contact and reference a request that includes the contact.
 * - `recordedAt` is non-decreasing, with zero steps (shared milliseconds) mixed in.
 *
 * The builder also returns `expected`: the final item status/lifecycle/version/needs-review/deps
 * according to its own model, an oracle independent of `reduce`.
 */
import fc from "fast-check";
import { nextRecordedAt, sealEvent, GENESIS_PREV_HASH } from "../chain";
import { buildAttestation, evaluateConsent, DEFAULT_CONSENT_POLICY, type ConsentInput } from "../consent";
import { itemContentHash } from "../content-hash";
import {
  KIND_LETTER,
  KINDS,
  type Actor,
  type EventDraft,
  type Kind,
  type Manual,
  type Provenance,
  type SourceFormat,
  type SourceType,
  type Span,
  type StoredEvent,
} from "../events";
import { sha256Hex } from "../hash";
import type { ItemLifecycle, ItemStatus } from "../state";

// ---------------------------------------------------------------------------------------------
// Clocks and chaining

/** A clock that returns `start`, `start + stepMs`, `start + 2·stepMs`, ... (new Date each call). */
export function steppingClock(start: Date, stepMs = 1000): () => Date {
  let t = start.getTime();
  return () => {
    const now = new Date(t);
    t += stepMs;
    return now;
  };
}

/**
 * A clock that replays `times` in order, then keeps returning the last one. Use with
 * `GeneratedEngagement.recordedAt` when the append path calls the clock exactly once per draft.
 */
export function clockFrom(times: readonly Date[]): () => Date {
  let i = 0;
  return () => {
    const t = times[Math.min(i, times.length - 1)];
    i++;
    if (!t) throw new Error("clockFrom: no times");
    return new Date(t.getTime());
  };
}

export interface ChainOptions {
  orgId: string;
  engagementId: string;
  clock: () => Date;
  /** Continue an existing log (defaults to an empty one). */
  head?: { seq: number; hash: string; recordedAt: Date | null };
}

/** Seals drafts into a hash-chained StoredEvent[] the way the append path does (pure). */
export function chainDrafts(drafts: readonly EventDraft[], opts: ChainOptions): StoredEvent[] {
  let seq = opts.head?.seq ?? 0;
  let prevHash = opts.head?.hash ?? GENESIS_PREV_HASH;
  let prevRecordedAt = opts.head?.recordedAt ?? null;
  const out: StoredEvent[] = [];
  for (const draft of drafts) {
    const recordedAt = nextRecordedAt(opts.clock(), prevRecordedAt);
    seq += 1;
    const event = sealEvent(draft, { orgId: opts.orgId, engagementId: opts.engagementId, seq, prevHash, recordedAt });
    out.push(event);
    prevHash = event.hash;
    prevRecordedAt = event.recordedAt;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Generated scenario

export interface ExpectedItem {
  shortId: string;
  kind: Kind;
  currentVersion: number;
  status: ItemStatus;
  lifecycle: ItemLifecycle;
  needsReview: boolean;
  dependsOn: string[];
}

export interface GeneratedEngagement {
  orgId: string;
  engagementId: string;
  shortCode: string;
  timeZone: string;
  /** app_user ids used as actors, `entered_by`, `attested_by`. */
  userIds: string[];
  /** client_contact ids used in requests, authorizations and responses. */
  contactIds: string[];
  drafts: EventDraft[];
  /** Planned recorded_at per draft (non-decreasing, ms). `clockFrom(recordedAt)` replays it. */
  recordedAt: Date[];
  /** Final item facts according to the generator's own model (keyed by item id). */
  expected: Map<string, ExpectedItem>;
}

export interface GeneratedLog extends GeneratedEngagement {
  events: StoredEvent[];
}

export interface EngagementLogOptions {
  /** Number of abstract operations (each yields 0..n events). Defaults 10..60. */
  minOps?: number;
  maxOps?: number;
}

const OP_WEIGHTS = {
  ingest: 3,
  redact: 1,
  create: 10,
  revise: 5,
  supersede: 1,
  withdraw: 1,
  addDep: 4,
  removeDep: 2,
  clearReview: 3,
  request: 5,
  revoke: 1,
  authorize: 5,
  respond: 12,
  erase: 1,
  update: 1,
} as const;
type OpTag = keyof typeof OP_WEIGHTS;

interface Op {
  tag: OpTag;
  r: number[];
  words: string[];
  stepMs: number;
}

const WORDS = [
  "freight",
  "invoice",
  "carrier",
  "dispatch",
  "route",
  "export",
  "nightly",
  "dashboard",
  "approval",
  "warehouse",
  "SLA",
  "API",
  "must",
  "should",
  "within",
  "48h",
  "the",
  "client",
  "café",
  "naïve",
  "日本語",
  "🚚",
  "\"quoted\"",
  "back\\slash",
];

const TIME_ZONES = ["America/New_York", "America/Los_Angeles", "Europe/Berlin", "Asia/Tokyo", "UTC"];
const DAY = 86_400_000;

const arbOp: fc.Arbitrary<Op> = fc.record({
  tag: fc.oneof(
    ...(Object.entries(OP_WEIGHTS) as [OpTag, number][]).map(([tag, weight]) => ({ arbitrary: fc.constant(tag), weight })),
  ),
  r: fc.array(fc.nat({ max: 1_000_000 }), { minLength: 8, maxLength: 8 }),
  words: fc.array(fc.constantFrom(...WORDS), { minLength: 2, maxLength: 9 }),
  stepMs: fc.oneof(
    { arbitrary: fc.constant(0), weight: 2 },
    { arbitrary: fc.integer({ min: 1, max: 900_000 }), weight: 8 },
    { arbitrary: fc.integer({ min: DAY / 2, max: 6 * DAY }), weight: 1 },
  ),
});

interface BuildInput {
  orgSeed: string;
  engagementSeed: string;
  shortCode: string;
  timeZone: string;
  userCount: number;
  contactCount: number;
  startMs: number;
  ops: Op[];
}

/** Deterministic UUIDv4-shaped id derived from a seed and a label. */
function deriveUuid(seed: string, label: string): string {
  const h = sha256Hex(`${seed}:${label}`);
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

interface MSource {
  id: string;
  sha: string;
  charLength: number;
  occurredAt: Date;
  redacted: boolean;
}
interface MVersion {
  version: number;
  contentHash: string;
  spans: Span[];
  manual: Manual | null;
}
interface MResponse {
  contactId: string;
  version: number;
  contentHash: string;
  response: "confirmed" | "disputed";
}
interface MItem {
  id: string;
  shortId: string;
  kind: Kind;
  versions: MVersion[];
  lifecycle: ItemLifecycle;
  deps: string[];
  needsReview: boolean;
  responses: MResponse[];
}
interface MContact {
  id: string;
  erased: boolean;
  auth: "granted" | "declined" | null;
}
interface MRequest {
  id: string;
  items: { item_id: string; version: number; content_hash: string }[];
  contactIds: string[];
  revoked: Set<string>;
  revokedAll: boolean;
  expiresAt: number;
}

function current(item: MItem): MVersion {
  return item.versions[item.versions.length - 1]!;
}

/** Oracle status: latest response per contact on the current version (D-009). */
function modelStatus(item: MItem): ItemStatus {
  const cur = current(item);
  const latest = new Map<string, "confirmed" | "disputed">();
  for (const r of item.responses) if (r.version === cur.version && r.contentHash === cur.contentHash) latest.set(r.contactId, r.response);
  const values = [...latest.values()];
  if (values.includes("disputed")) return "disputed";
  if (values.includes("confirmed")) return "confirmed";
  return "pending";
}

function pick<T>(arr: readonly T[], r: number): T | undefined {
  return arr.length === 0 ? undefined : arr[r % arr.length];
}

/** Picks a pseudo-random subset (stable order) using the bits of r; at least one when `nonEmpty`. */
function subset<T>(arr: readonly T[], r: number, max: number, nonEmpty: boolean): T[] {
  const out = arr.filter((_, i) => ((r >> i % 20) & 1) === 1).slice(0, max);
  if (out.length === 0 && nonEmpty && arr.length > 0) out.push(arr[r % arr.length]!);
  return out;
}

function build(input: BuildInput): GeneratedEngagement {
  const { orgSeed, engagementSeed, shortCode } = input;
  const orgId = deriveUuid(orgSeed, "org");
  const engagementId = deriveUuid(engagementSeed, "engagement");
  const id = (label: string) => deriveUuid(engagementId, label);
  const userIds = Array.from({ length: input.userCount }, (_, i) => id(`user:${i}`));
  const contacts: MContact[] = Array.from({ length: input.contactCount }, (_, i) => ({
    id: id(`contact:${i}`),
    erased: false,
    auth: null,
  }));
  const sources: MSource[] = [];
  const items: MItem[] = [];
  const requests: MRequest[] = [];
  const counters: Record<Kind, number> = { problem: 0, constraint: 0, assumption: 0, decision: 0, requirement: 0 };
  const drafts: EventDraft[] = [];
  const recordedAt: Date[] = [];
  let now = input.startMs;
  let serial = 0;
  const next = (label: string) => id(`${label}:${serial++}`);
  const user = (r: number): Actor => ({ type: "user", id: userIds[r % userIds.length]! });
  const emit = (draft: EventDraft) => {
    drafts.push(draft);
    recordedAt.push(new Date(now));
  };

  const active = () => items.filter((i) => i.lifecycle === "active");
  const flagDependents = (upstreamId: string) => {
    for (const d of items) if (d.id !== upstreamId && d.lifecycle === "active" && d.deps.includes(upstreamId)) d.needsReview = true;
  };
  const wouldCycle = (from: string, to: string) => {
    const stack = [to];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === from) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const it = items.find((i) => i.id === cur);
      if (it) stack.push(...it.deps);
    }
    return false;
  };
  const newSpans = (r: number[], count: number): Span[] => {
    const usable = sources.filter((s) => !s.redacted);
    const spans: Span[] = [];
    for (let k = 0; k < count && usable.length > 0; k++) {
      const s = usable[(r[k % r.length]! + k) % usable.length]!;
      const start = (r[(k + 1) % r.length]! * (k + 3)) % (s.charLength - 1);
      const end = start + 1 + (r[(k + 2) % r.length]! % Math.min(240, s.charLength - start - 1));
      const span = { source_id: s.id, source_sha256: s.sha, start, end };
      if (!spans.some((x) => x.source_id === span.source_id && x.start === span.start && x.end === span.end)) spans.push(span);
    }
    return spans;
  };
  const occurredFor = (spans: Span[], r: number) => {
    const src = spans[0] ? sources.find((s) => s.id === spans[0]!.source_id) : undefined;
    return src ? src.occurredAt : new Date(now - (r % (10 * DAY)));
  };
  const provenance = (r: number): Provenance =>
    r % 3 === 0
      ? { via: "manual" }
      : { via: "ai_candidate", candidate_id: next("candidate"), model: "test-model", prompt_version: "extract.v1", edited: r % 2 === 0 };

  const ingest = (r: number[]) => {
    const sourceType: SourceType = (["human_notes", "machine_transcript", "email", "chat_export"] as const)[r[0]! % 4]!;
    const formats: Record<SourceType, SourceFormat[]> = {
      human_notes: ["txt", "md", "docx", "paste"],
      machine_transcript: ["vtt", "srt", "txt"],
      email: ["txt", "paste"],
      chat_export: ["txt", "md"],
    };
    const format = pick(formats[sourceType], r[1]!)!;
    const jurisdictions = subset(["NY", "TX", "US-CA", "GB", "Washington"], r[2]!, 3, false);
    let consent: ConsentInput = {
      sourceType,
      format,
      allParticipantsConsented: r[3]! % 2 === 0 ? true : null,
      jurisdictions,
      jurisdictionsKnown: jurisdictions.length > 0,
    };
    let result = evaluateConsent(consent, DEFAULT_CONSENT_POLICY);
    if (result.decision === "blocked") {
      consent = { ...consent, allParticipantsConsented: true };
      result = evaluateConsent(consent, DEFAULT_CONSENT_POLICY);
    }
    const actor = user(r[4]!);
    const source: MSource = {
      id: next("source"),
      sha: "",
      charLength: 200 + (r[5]! % 6000),
      occurredAt: new Date(now - (r[6]! % (30 * DAY))),
      redacted: false,
    };
    source.sha = sha256Hex(`synthetic source text ${source.id}`);
    sources.push(source);
    emit({
      type: "source_ingested",
      actor,
      occurredAt: source.occurredAt,
      payload: {
        source_id: source.id,
        source_type: result.effectiveSourceType,
        format,
        content_sha256: source.sha,
        char_length: source.charLength,
        participant_count: r[7]! % 7,
        attestation: buildAttestation(consent, DEFAULT_CONSENT_POLICY, result, actor.id!),
      },
    });
  };

  // Genesis, then one source so early ops have something to cite.
  emit({
    type: "engagement_created",
    actor: user(0),
    payload: {
      engagement_id: engagementId,
      short_code: shortCode,
      name: "Synthetic engagement",
      client_name: "Fictional Client Co",
      time_zone: input.timeZone,
    },
  });
  ingest([1, 2, 3, 4, 5, 6, 7, 8]);

  const applyOp = (tag: OpTag, op: Op) => {
    const r = op.r;
    const r0 = r[0]!;
    const r1 = r[1]!;
    const r2 = r[2]!;
    const r3 = r[3]!;
    const statement = op.words.join(" ");
    switch (tag) {
      case "ingest":
        ingest(r);
        break;
      case "redact": {
        const s = pick(
          sources.filter((x) => !x.redacted),
          r0,
        );
        if (!s) break;
        s.redacted = true;
        const system = r1 % 5 === 0;
        emit({
          type: "source_redacted",
          actor: system ? { type: "system", id: null } : user(r2),
          payload: {
            source_id: s.id,
            reason_code: system ? "retention" : pick(["user_request", "consent_withdrawn", "uploaded_in_error", "other"] as const, r3)!,
          },
        });
        break;
      }
      case "create": {
        const kind = KINDS[r0 % KINDS.length]!;
        const spans = newSpans(r.slice(2), r1 % 4);
        const manual = spans.length === 0 ? { entered_by: userIds[r2 % userIds.length]! } : null;
        const deps =
          kind === "decision" || kind === "requirement"
            ? subset(
                active().map((i) => i.id),
                r3,
                3,
                false,
              )
            : [];
        counters[kind] += 1;
        const itemId = next("item");
        const shortId = `${shortCode}-${KIND_LETTER[kind]}${counters[kind]}`;
        const contentHash = itemContentHash({ engagement_id: engagementId, item_id: itemId, kind, version: 1, statement, spans, manual });
        items.push({
          id: itemId,
          shortId,
          kind,
          versions: [{ version: 1, contentHash, spans, manual }],
          lifecycle: "active",
          deps: [...deps],
          needsReview: false,
          responses: [],
        });
        emit({
          type: "item_created",
          actor: user(r2),
          occurredAt: occurredFor(spans, r[4]!),
          payload: {
            item_id: itemId,
            short_id: shortId,
            kind,
            version: 1,
            statement,
            spans,
            manual,
            depends_on: deps,
            provenance: provenance(r[5]!),
            content_hash: contentHash,
          },
        });
        break;
      }
      case "revise": {
        const item = pick(active(), r0);
        if (!item) break;
        const prev = current(item);
        const carried = prev.spans.filter((_, i) => ((r1 >> i) & 1) === 1);
        const added = newSpans(r.slice(3), r2 % 3).filter(
          (s) => !carried.some((c) => c.source_id === s.source_id && c.start === s.start && c.end === s.end),
        );
        const spans = [...carried, ...added];
        const manual = spans.length === 0 ? { entered_by: userIds[r3 % userIds.length]! } : null;
        const version = prev.version + 1;
        const text = r3 % 4 === 0 ? statement : `${statement} (rev ${version})`;
        const contentHash = itemContentHash({
          engagement_id: engagementId,
          item_id: item.id,
          kind: item.kind,
          version,
          statement: text,
          spans,
          manual,
        });
        item.versions.push({ version, contentHash, spans, manual });
        item.needsReview = false;
        flagDependents(item.id);
        emit({
          type: "item_revised",
          actor: user(r3),
          occurredAt: occurredFor(spans, r[6]!),
          payload: {
            item_id: item.id,
            version,
            statement: text,
            spans,
            manual,
            provenance: provenance(r[7]!),
            reason_code: pick(["client_dispute", "new_information", "correction", "scope_change", "other"] as const, r2)!,
            content_hash: contentHash,
            previous_content_hash: prev.contentHash,
          },
        });
        break;
      }
      case "supersede": {
        const pool = active();
        const item = pick(pool, r0);
        const by = pick(
          pool.filter((i) => i !== item),
          r1,
        );
        if (!item || !by) break;
        item.lifecycle = "superseded";
        flagDependents(item.id);
        emit({
          type: "item_superseded",
          actor: user(r2),
          payload: {
            item_id: item.id,
            superseded_by_item_id: by.id,
            reason_code: pick(["new_information", "scope_change", "kind_change", "duplicate", "other"] as const, r3)!,
          },
        });
        break;
      }
      case "withdraw": {
        const item = pick(active(), r0);
        if (!item) break;
        item.lifecycle = "withdrawn";
        flagDependents(item.id);
        emit({
          type: "item_withdrawn",
          actor: user(r1),
          payload: {
            item_id: item.id,
            reason_code: pick(["client_dispute", "out_of_scope", "duplicate", "entered_in_error", "other"] as const, r2)!,
          },
        });
        break;
      }
      case "addDep": {
        const pool = active();
        const dependents = pool.filter((i) => i.kind === "decision" || i.kind === "requirement");
        const d = pick(dependents, r0);
        if (!d) break;
        const candidates = pool.filter((u) => u.id !== d.id && !d.deps.includes(u.id) && !wouldCycle(d.id, u.id));
        const u = pick(candidates, r1);
        if (!u) break;
        d.deps.push(u.id);
        emit({ type: "dependency_added", actor: user(r2), payload: { item_id: d.id, depends_on_item_id: u.id } });
        break;
      }
      case "removeDep": {
        const d = pick(
          active().filter((i) => i.deps.length > 0),
          r0,
        );
        if (!d) break;
        const u = pick(d.deps, r1)!;
        d.deps = d.deps.filter((x) => x !== u);
        emit({ type: "dependency_removed", actor: user(r2), payload: { item_id: d.id, depends_on_item_id: u } });
        break;
      }
      case "clearReview": {
        const d = pick(
          active().filter((i) => i.needsReview),
          r0,
        );
        if (!d) break;
        d.needsReview = false;
        emit({ type: "review_cleared", actor: user(r1), payload: { item_id: d.id } });
        break;
      }
      case "request": {
        const eligible = active().filter((i) => modelStatus(i) !== "confirmed");
        const chosen = subset(eligible, r0, 5, true);
        const reachable = contacts.filter((c) => !c.erased);
        const chosenContacts = subset(reachable, r1, 3, true);
        if (chosen.length === 0 || chosenContacts.length === 0) break;
        const expiresAt = now + (r2 % 6 === 0 ? 2 * 3_600_000 : 14 * DAY);
        const request: MRequest = {
          id: next("request"),
          items: chosen.map((i) => ({ item_id: i.id, version: current(i).version, content_hash: current(i).contentHash })),
          contactIds: chosenContacts.map((c) => c.id),
          revoked: new Set(),
          revokedAll: false,
          expiresAt,
        };
        requests.push(request);
        emit({
          type: "confirmation_requested",
          actor: user(r3),
          payload: {
            request_id: request.id,
            items: request.items.map((i) => ({ ...i })),
            contact_ids: [...request.contactIds],
            expires_at: new Date(expiresAt).toISOString(),
            channel: "email_link",
          },
        });
        break;
      }
      case "revoke": {
        const req = pick(
          requests.filter((q) => !q.revokedAll),
          r0,
        );
        if (!req) break;
        const open = req.contactIds.filter((c) => !req.revoked.has(c));
        const all = r1 % 3 === 0 || open.length === 0;
        const contactId = all ? null : pick(open, r2)!;
        if (contactId === null) req.revokedAll = true;
        else req.revoked.add(contactId);
        emit({ type: "confirmation_revoked", actor: user(r3), payload: { request_id: req.id, contact_id: contactId } });
        break;
      }
      case "authorize": {
        const candidates = contacts.filter((c) => !c.erased && requests.some((q) => q.contactIds.includes(c.id)));
        const contact = pick(candidates, r0);
        if (!contact) break;
        const req = pick(
          requests.filter((q) => q.contactIds.includes(contact.id)),
          r1,
        )!;
        const granted = r2 % 4 !== 0;
        contact.auth = granted ? "granted" : "declined";
        const text = "I authorize Quillfield Labs to record my confirmations for the Synthetic engagement.";
        const payload = {
          contact_id: contact.id,
          request_id: req.id,
          text_version: "v1",
          text,
          text_sha256: sha256Hex(text),
          evidence_commitment: sha256Hex(`evidence:${serial++}`),
        };
        const actor: Actor = { type: "contact", id: contact.id };
        emit(granted ? { type: "authorization_granted", actor, payload } : { type: "authorization_declined", actor, payload });
        break;
      }
      case "respond": {
        const pairs: { req: MRequest; contact: MContact; items: MItem[] }[] = [];
        for (const req of requests) {
          if (req.revokedAll || now >= req.expiresAt) continue;
          const itemsOk = req.items
            .map((ri) => items.find((i) => i.id === ri.item_id && i.lifecycle === "active" && current(i).version === ri.version && current(i).contentHash === ri.content_hash))
            .filter((i): i is MItem => i !== undefined);
          if (itemsOk.length === 0) continue;
          for (const cid of req.contactIds) {
            const contact = contacts.find((c) => c.id === cid)!;
            if (contact.erased || contact.auth !== "granted" || req.revoked.has(cid)) continue;
            pairs.push({ req, contact, items: itemsOk });
          }
        }
        const pair = pick(pairs, r0);
        if (!pair) break;
        const submissionId = next("submission");
        const actor: Actor = { type: "contact", id: pair.contact.id };
        for (const [k, item] of subset(pair.items, r1, 5, true).entries()) {
          const cur = current(item);
          const disputed = (r2 >> k) % 4 === 0;
          item.responses.push({ contactId: pair.contact.id, version: cur.version, contentHash: cur.contentHash, response: disputed ? "disputed" : "confirmed" });
          const base = {
            item_id: item.id,
            version: cur.version,
            content_hash: cur.contentHash,
            contact_id: pair.contact.id,
            request_id: pair.req.id,
            submission_id: submissionId,
            channel: "email_link" as const,
            evidence_commitment: sha256Hex(`evidence:${serial++}`),
          };
          if (disputed) {
            flagDependents(item.id);
            emit({ type: "item_disputed", actor, payload: { ...base, comment_commitment: sha256Hex(`comment:${serial++}`) } });
          } else {
            emit({ type: "item_confirmed", actor, payload: base });
          }
        }
        break;
      }
      case "erase": {
        const contact = pick(
          contacts.filter((c) => !c.erased),
          r0,
        );
        if (!contact) break;
        contact.erased = true;
        emit({ type: "contact_erased", actor: user(r1), payload: { contact_id: contact.id } });
        break;
      }
      case "update": {
        const fields = r0 % 7;
        const payload: { name?: string; client_name?: string; time_zone?: string } = {};
        if (fields & 1 || fields === 0) payload.name = `Synthetic engagement ${r1 % 100}`;
        if (fields & 2) payload.client_name = `Fictional Client ${r2 % 100}`;
        if (fields & 4) payload.time_zone = pick(TIME_ZONES, r3)!;
        emit({ type: "engagement_updated", actor: user(r1), payload });
        break;
      }
    }
  };

  for (const op of input.ops) {
    now += op.stepMs;
    const before = drafts.length;
    applyOp(op.tag, op);
    // An op that does not apply yet (e.g. respond before any request) creates an item instead,
    // which keeps generated logs dense.
    if (drafts.length === before) applyOp("create", op);
  }

  const expected = new Map<string, ExpectedItem>();
  for (const item of items) {
    expected.set(item.id, {
      shortId: item.shortId,
      kind: item.kind,
      currentVersion: current(item).version,
      status: modelStatus(item),
      lifecycle: item.lifecycle,
      needsReview: item.needsReview,
      dependsOn: [...item.deps].sort(),
    });
  }

  return {
    orgId,
    engagementId,
    shortCode,
    timeZone: input.timeZone,
    userIds,
    contactIds: contacts.map((c) => c.id),
    drafts,
    recordedAt,
    expected,
  };
}

/** Valid draft sequences for one engagement (see module comment). */
export function arbEngagementLog(options: EngagementLogOptions = {}): fc.Arbitrary<GeneratedEngagement> {
  const minOps = options.minOps ?? 10;
  const maxOps = options.maxOps ?? 60;
  return fc
    .record({
      orgSeed: fc.uuid({ version: 4 }),
      engagementSeed: fc.uuid({ version: 4 }),
      shortCode: fc.stringMatching(/^[A-Z][A-Z0-9]{1,5}$/),
      timeZone: fc.constantFrom(...TIME_ZONES),
      userCount: fc.integer({ min: 1, max: 3 }),
      contactCount: fc.integer({ min: 1, max: 4 }),
      startMs: fc.integer({ min: Date.UTC(2025, 0, 1), max: Date.UTC(2026, 5, 1) }),
      // Unbiased: biased generation tends to repeat one inapplicable op and yield near-empty logs.
      ops: fc.noBias(fc.array(arbOp, { minLength: minOps, maxLength: maxOps, size: "max" })),
    })
    .map(build);
}

/** Seals a generated engagement's drafts with its planned clock. */
export function storedEventsOf(gen: GeneratedEngagement): StoredEvent[] {
  return chainDrafts(gen.drafts, { orgId: gen.orgId, engagementId: gen.engagementId, clock: clockFrom(gen.recordedAt) });
}

/** Like `arbEngagementLog`, plus the chained `events`. */
export function arbStoredLog(options: EngagementLogOptions = {}): fc.Arbitrary<GeneratedLog> {
  return arbEngagementLog(options).map((gen) => ({ ...gen, events: storedEventsOf(gen) }));
}
