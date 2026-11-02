/**
 * Hand-written event logs for unit tests: readable names instead of UUIDs, a manual clock, and
 * content hashes / short ids computed for you. Test-only.
 */
import { GENESIS_PREV_HASH, nextRecordedAt, sealEvent } from "../chain";
import { itemContentHash } from "../content-hash";
import {
  KIND_LETTER,
  type Actor,
  type Attestation,
  type EventDraft,
  type Kind,
  type Manual,
  type ReviseReason,
  type Span,
  type StoredEvent,
} from "../events";
import { sha256Hex } from "../hash";

/** Deterministic lowercase UUIDv4-shaped id for a label. */
export function testUuid(label: string): string {
  const h = sha256Hex(`test:${label}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const TEST_ATTESTATION = (attestedBy: string): Attestation => ({
  attested_by: attestedBy,
  source_type: "human_notes",
  all_participants_consented: null,
  participant_jurisdictions: [],
  jurisdictions_known: false,
  policy: { version: 1, all_party_states: ["CA"], block_unknown_jurisdictions: true },
  decision: "allowed",
  rule: "not_machine_transcript",
});

interface BuiltItem {
  id: string;
  kind: Kind;
  version: number;
  contentHash: string;
  spans: Span[];
  manual: Manual | null;
}

export interface SpanRef {
  source: string;
  start: number;
  end: number;
}

export class LogBuilder {
  readonly orgId = testUuid("org");
  readonly engagementId: string;
  readonly userId = testUuid("user");
  readonly shortCode: string;
  private readonly events: StoredEvent[] = [];
  private now: number;
  private readonly items = new Map<string, BuiltItem>();
  private readonly counters: Record<Kind, number> = { problem: 0, constraint: 0, assumption: 0, decision: 0, requirement: 0 };
  private submissionSerial = 0;

  constructor(opts: { start?: Date; shortCode?: string; engagement?: string } = {}) {
    this.now = (opts.start ?? new Date("2026-03-02T15:00:00.000Z")).getTime();
    this.shortCode = opts.shortCode ?? "HALV";
    this.engagementId = testUuid(`engagement:${opts.engagement ?? "e1"}`);
  }

  id(label: string): string {
    return testUuid(`${this.engagementId}:${label}`);
  }

  item(name: string): BuiltItem {
    const it = this.items.get(name);
    if (!it) throw new Error(`unknown item ${name}`);
    return it;
  }

  /** Sets the clock (recorded_at of the next events). */
  at(time: string | Date): this {
    this.now = new Date(time).getTime();
    return this;
  }

  tick(ms = 60_000): this {
    this.now += ms;
    return this;
  }

  get time(): Date {
    return new Date(this.now);
  }

  get log(): StoredEvent[] {
    return [...this.events];
  }

  get last(): StoredEvent {
    return this.events[this.events.length - 1]!;
  }

  private user(): Actor {
    return { type: "user", id: this.userId };
  }

  push(draft: EventDraft): StoredEvent {
    const prev = this.events[this.events.length - 1];
    const event = sealEvent(draft, {
      orgId: this.orgId,
      engagementId: this.engagementId,
      seq: (prev?.seq ?? 0) + 1,
      prevHash: prev?.hash ?? GENESIS_PREV_HASH,
      recordedAt: nextRecordedAt(new Date(this.now), prev?.recordedAt ?? null),
    });
    this.events.push(event);
    return event;
  }

  engagement(opts: { name?: string; clientName?: string; timeZone?: string } = {}): this {
    this.push({
      type: "engagement_created",
      actor: this.user(),
      payload: {
        engagement_id: this.engagementId,
        short_code: this.shortCode,
        name: opts.name ?? "Halvorsen rollout",
        client_name: opts.clientName ?? "Halvorsen Freight",
        time_zone: opts.timeZone ?? "America/New_York",
      },
    });
    return this;
  }

  source(name: string, opts: { occurredAt?: string; charLength?: number } = {}): this {
    this.push({
      type: "source_ingested",
      actor: this.user(),
      occurredAt: new Date(opts.occurredAt ?? "2026-03-01T14:00:00.000Z"),
      payload: {
        source_id: this.id(`source:${name}`),
        source_type: "human_notes",
        format: "md",
        content_sha256: sha256Hex(`text of ${name}`),
        char_length: opts.charLength ?? 1000,
        participant_count: 3,
        attestation: TEST_ATTESTATION(this.userId),
      },
    });
    return this;
  }

  span(ref: SpanRef): Span {
    return { source_id: this.id(`source:${ref.source}`), source_sha256: sha256Hex(`text of ${ref.source}`), start: ref.start, end: ref.end };
  }

  create(
    name: string,
    kind: Kind,
    statement: string,
    opts: { spans?: SpanRef[]; dependsOn?: string[]; occurredAt?: string } = {},
  ): this {
    const spans = (opts.spans ?? []).map((s) => this.span(s));
    const manual = spans.length === 0 ? { entered_by: this.userId } : null;
    const id = this.id(`item:${name}`);
    this.counters[kind] += 1;
    const contentHash = itemContentHash({ engagement_id: this.engagementId, item_id: id, kind, version: 1, statement, spans, manual });
    this.items.set(name, { id, kind, version: 1, contentHash, spans, manual });
    this.push({
      type: "item_created",
      actor: this.user(),
      occurredAt: new Date(opts.occurredAt ?? "2026-03-01T14:00:00.000Z"),
      payload: {
        item_id: id,
        short_id: `${this.shortCode}-${KIND_LETTER[kind]}${this.counters[kind]}`,
        kind,
        version: 1,
        statement,
        spans,
        manual,
        depends_on: (opts.dependsOn ?? []).map((d) => this.item(d).id),
        provenance: { via: "manual" },
        content_hash: contentHash,
      },
    });
    return this;
  }

  /** Revises an item. `keepSpans` carries the current spans (default true); `spans` adds new ones. */
  revise(name: string, statement: string, opts: { keepSpans?: boolean; spans?: SpanRef[]; reason?: ReviseReason } = {}): this {
    const it = this.item(name);
    const spans = [...(opts.keepSpans === false ? [] : it.spans), ...(opts.spans ?? []).map((s) => this.span(s))];
    const manual = spans.length === 0 ? { entered_by: this.userId } : null;
    const version = it.version + 1;
    const contentHash = itemContentHash({ engagement_id: this.engagementId, item_id: it.id, kind: it.kind, version, statement, spans, manual });
    const previous = it.contentHash;
    this.items.set(name, { ...it, version, contentHash, spans, manual });
    this.push({
      type: "item_revised",
      actor: this.user(),
      occurredAt: new Date("2026-03-01T14:00:00.000Z"),
      payload: {
        item_id: it.id,
        version,
        statement,
        spans,
        manual,
        provenance: { via: "manual" },
        reason_code: opts.reason ?? "new_information",
        content_hash: contentHash,
        previous_content_hash: previous,
      },
    });
    return this;
  }

  supersede(name: string, by: string): this {
    this.push({
      type: "item_superseded",
      actor: this.user(),
      payload: { item_id: this.item(name).id, superseded_by_item_id: this.item(by).id, reason_code: "scope_change" },
    });
    return this;
  }

  withdraw(name: string): this {
    this.push({ type: "item_withdrawn", actor: this.user(), payload: { item_id: this.item(name).id, reason_code: "out_of_scope" } });
    return this;
  }

  addDep(name: string, upstream: string): this {
    this.push({
      type: "dependency_added",
      actor: this.user(),
      payload: { item_id: this.item(name).id, depends_on_item_id: this.item(upstream).id },
    });
    return this;
  }

  removeDep(name: string, upstream: string): this {
    this.push({
      type: "dependency_removed",
      actor: this.user(),
      payload: { item_id: this.item(name).id, depends_on_item_id: this.item(upstream).id },
    });
    return this;
  }

  clearReview(name: string): this {
    this.push({ type: "review_cleared", actor: this.user(), payload: { item_id: this.item(name).id } });
    return this;
  }

  /** Requests confirmation of the items at their current versions. */
  request(name: string, items: string[], contacts: string[], expiresInMs = 14 * 86_400_000): this {
    this.push({
      type: "confirmation_requested",
      actor: this.user(),
      payload: {
        request_id: this.id(`request:${name}`),
        items: items.map((i) => {
          const it = this.item(i);
          return { item_id: it.id, version: it.version, content_hash: it.contentHash };
        }),
        contact_ids: contacts.map((c) => this.id(`contact:${c}`)),
        expires_at: new Date(this.now + expiresInMs).toISOString(),
        channel: "email_link",
      },
    });
    return this;
  }

  revoke(request: string, contact: string | null): this {
    this.push({
      type: "confirmation_revoked",
      actor: this.user(),
      payload: { request_id: this.id(`request:${request}`), contact_id: contact === null ? null : this.id(`contact:${contact}`) },
    });
    return this;
  }

  authorize(contact: string, request: string, granted = true): this {
    const text = "I authorize Quillfield Labs to record my confirmations.";
    const payload = {
      contact_id: this.id(`contact:${contact}`),
      request_id: this.id(`request:${request}`),
      text_version: "v1",
      text,
      text_sha256: sha256Hex(text),
      evidence_commitment: sha256Hex(`evidence:${contact}:${this.events.length}`),
    };
    const actor: Actor = { type: "contact", id: payload.contact_id };
    this.push(granted ? { type: "authorization_granted", actor, payload } : { type: "authorization_declined", actor, payload });
    return this;
  }

  /** A response on the item's current version (or an explicit older `version` with its hash). */
  respond(
    decision: "confirmed" | "disputed",
    name: string,
    contact: string,
    request: string,
    opts: { version?: number; contentHash?: string; submission?: string } = {},
  ): this {
    const it = this.item(name);
    const base = {
      item_id: it.id,
      version: opts.version ?? it.version,
      content_hash: opts.contentHash ?? it.contentHash,
      contact_id: this.id(`contact:${contact}`),
      request_id: this.id(`request:${request}`),
      submission_id: this.id(`submission:${opts.submission ?? String(this.submissionSerial++)}`),
      channel: "email_link" as const,
      evidence_commitment: sha256Hex(`evidence:${this.events.length}`),
    };
    const actor: Actor = { type: "contact", id: base.contact_id };
    this.push(
      decision === "confirmed"
        ? { type: "item_confirmed", actor, payload: base }
        : { type: "item_disputed", actor, payload: { ...base, comment_commitment: sha256Hex(`comment:${this.events.length}`) } },
    );
    return this;
  }

  confirm(name: string, contact: string, request: string, opts: { submission?: string } = {}): this {
    return this.respond("confirmed", name, contact, request, opts);
  }

  dispute(name: string, contact: string, request: string, opts: { submission?: string } = {}): this {
    return this.respond("disputed", name, contact, request, opts);
  }

  eraseContact(contact: string): this {
    this.push({ type: "contact_erased", actor: this.user(), payload: { contact_id: this.id(`contact:${contact}`) } });
    return this;
  }

  redact(source: string): this {
    this.push({
      type: "source_redacted",
      actor: this.user(),
      payload: { source_id: this.id(`source:${source}`), reason_code: "user_request" },
    });
    return this;
  }

  updateEngagement(payload: { name?: string; client_name?: string; time_zone?: string }): this {
    this.push({ type: "engagement_updated", actor: this.user(), payload });
    return this;
  }
}
