/**
 * Event payload schemas, schema_version 1 (ARCHITECTURE §3).
 *
 * Payload keys are snake_case. Payloads contain only JSON values: integers (never floats), strings,
 * booleans, null, arrays and plain objects. IDs are lowercase canonical UUID strings (the form
 * Postgres returns), hashes are lowercase hex, and timestamps inside payloads are
 * `Date.toISOString()` strings (ms, UTC) so they round-trip through jsonb byte-for-byte.
 *
 * Hashing never goes through zod output: `parseEventDraft` validates a draft and returns it with
 * the same structure (strict objects, no transforms), and the hash covers the stored raw values.
 */
import { z } from "zod";
import { canonicalJson } from "./canonical";

// ---------------------------------------------------------------------------------------------
// Primitives

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const HEX64_PATTERN = /^[0-9a-f]{64}$/;
export const ISO_MS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Lowercase canonical UUID (any version). */
export const Uuid = z.string().regex(UUID_PATTERN, "expected a lowercase UUID");
/** Lowercase hex SHA-256 / HMAC-SHA256 digest. */
export const Hex64 = z.string().regex(HEX64_PATTERN, "expected 64 lowercase hex characters");
/** Timestamp as produced by `Date.toISOString()`. */
export const IsoTimestamp = z
  .string()
  .regex(ISO_MS_PATTERN, "expected an ISO timestamp with milliseconds in UTC")
  .refine((s) => {
    const d = new Date(s);
    return !Number.isNaN(d.getTime()) && d.toISOString() === s;
  }, "invalid timestamp");

/** Text that jsonb can store: no NUL characters and no lone UTF-16 surrogates. */
const jsonbSafe = (s: string) => !s.includes("\u0000") && !LONE_SURROGATE.test(s);
const text = (min: number, max: number) =>
  z.string().min(min).max(max).refine(jsonbSafe, "text contains characters that cannot be stored");

export const NonNegativeInt = z.int().min(0);
export const PositiveInt = z.int().min(1);

// ---------------------------------------------------------------------------------------------
// Enums

export const KINDS = ["problem", "constraint", "assumption", "decision", "requirement"] as const;
export const Kind = z.enum(KINDS);
export type Kind = z.infer<typeof Kind>;

/** Short-id letter per kind (`<SHORT_CODE>-<K><n>`). */
export const KIND_LETTER: Readonly<Record<Kind, string>> = {
  problem: "P",
  constraint: "C",
  assumption: "A",
  decision: "D",
  requirement: "R",
};

export const SOURCE_TYPES = ["human_notes", "machine_transcript", "email", "chat_export"] as const;
export const SourceType = z.enum(SOURCE_TYPES);
export type SourceType = z.infer<typeof SourceType>;

export const SOURCE_FORMATS = ["txt", "md", "vtt", "srt", "docx", "paste"] as const;
export const SourceFormat = z.enum(SOURCE_FORMATS);
export type SourceFormat = z.infer<typeof SourceFormat>;

export const SourceRedactionReason = z.enum([
  "user_request",
  "retention",
  "consent_withdrawn",
  "uploaded_in_error",
  "other",
]);
export type SourceRedactionReason = z.infer<typeof SourceRedactionReason>;

export const ReviseReason = z.enum(["client_dispute", "new_information", "correction", "scope_change", "other"]);
export type ReviseReason = z.infer<typeof ReviseReason>;

/** Not enumerated in ARCHITECTURE §3; see DECISIONS D-034. */
export const SupersedeReason = z.enum([
  "client_dispute",
  "new_information",
  "correction",
  "scope_change",
  "kind_change",
  "duplicate",
  "other",
]);
export type SupersedeReason = z.infer<typeof SupersedeReason>;

export const WithdrawReason = z.enum(["client_dispute", "out_of_scope", "duplicate", "entered_in_error", "other"]);
export type WithdrawReason = z.infer<typeof WithdrawReason>;

export const ConfirmationChannelName = z.enum(["email_link"]);
export type ConfirmationChannelName = z.infer<typeof ConfirmationChannelName>;

/** Rules under which a source may be ingested (`evaluateConsent` allowed outcomes). */
export const ConsentAllowedRule = z.enum([
  "not_machine_transcript",
  "consent_attested",
  "no_all_party_jurisdiction",
  "unknown_jurisdiction_permitted",
]);
export type ConsentAllowedRule = z.infer<typeof ConsentAllowedRule>;

// ---------------------------------------------------------------------------------------------
// Shared payload parts

export const Span = z
  .strictObject({
    source_id: Uuid,
    source_sha256: Hex64,
    start: NonNegativeInt,
    end: PositiveInt,
  })
  .refine((s) => s.end > s.start, "span end must be greater than start");
export type Span = z.infer<typeof Span>;

export const Manual = z.strictObject({ entered_by: Uuid });
export type Manual = z.infer<typeof Manual>;

export const Provenance = z
  .strictObject({
    via: z.enum(["manual", "ai_candidate"]),
    candidate_id: Uuid.optional(),
    model: text(1, 200).optional(),
    prompt_version: text(1, 100).optional(),
    edited: z.boolean().optional(),
  })
  .refine((p) => p.via === "manual" || p.candidate_id !== undefined, "ai_candidate provenance needs candidate_id");
export type Provenance = z.infer<typeof Provenance>;

export const Statement = text(1, 2000).refine((s) => s.trim().length > 0, "statement is blank");

export const Attestation = z.strictObject({
  attested_by: Uuid,
  source_type: SourceType,
  all_participants_consented: z.boolean().nullable(),
  participant_jurisdictions: z.array(text(1, 64)).max(100),
  jurisdictions_known: z.boolean(),
  policy: z.strictObject({
    version: PositiveInt,
    all_party_states: z.array(text(1, 64)).max(100),
    block_unknown_jurisdictions: z.boolean(),
  }),
  decision: z.literal("allowed"),
  rule: ConsentAllowedRule,
});
export type Attestation = z.infer<typeof Attestation>;

const sourcedOrManual = (p: { spans: readonly unknown[]; manual: unknown }) => p.spans.length >= 1 !== (p.manual !== null);
const SOURCED_OR_MANUAL = "item version must have spans or manual, not both";

// ---------------------------------------------------------------------------------------------
// Payloads

export const EngagementCreatedPayload = z.strictObject({
  engagement_id: Uuid,
  short_code: z.string().regex(/^[A-Z0-9]{2,8}$/, "short code must be 2-8 characters A-Z/0-9"),
  name: text(1, 200),
  client_name: text(1, 200),
  time_zone: text(1, 64),
});

export const EngagementUpdatedPayload = z
  .strictObject({
    name: text(1, 200).optional(),
    client_name: text(1, 200).optional(),
    time_zone: text(1, 64).optional(),
  })
  .refine((p) => Object.keys(p).length > 0, "engagement_updated needs at least one field");

export const SourceIngestedPayload = z.strictObject({
  source_id: Uuid,
  source_type: SourceType,
  format: SourceFormat,
  content_sha256: Hex64,
  char_length: NonNegativeInt,
  participant_count: NonNegativeInt,
  attestation: Attestation,
});

export const SourceRedactedPayload = z.strictObject({
  source_id: Uuid,
  reason_code: SourceRedactionReason,
});

export const ItemCreatedPayload = z
  .strictObject({
    item_id: Uuid,
    short_id: z.string().regex(/^[A-Z0-9]{2,8}-[PCADR][1-9][0-9]*$/, "invalid short id"),
    kind: Kind,
    version: z.literal(1),
    statement: Statement,
    spans: z.array(Span).max(50),
    manual: Manual.nullable(),
    depends_on: z.array(Uuid).max(200),
    provenance: Provenance,
    content_hash: Hex64,
  })
  .refine(sourcedOrManual, SOURCED_OR_MANUAL);

export const ItemRevisedPayload = z
  .strictObject({
    item_id: Uuid,
    version: z.int().min(2),
    statement: Statement,
    spans: z.array(Span).max(50),
    manual: Manual.nullable(),
    provenance: Provenance,
    reason_code: ReviseReason,
    content_hash: Hex64,
    previous_content_hash: Hex64,
  })
  .refine(sourcedOrManual, SOURCED_OR_MANUAL);

export const ItemSupersededPayload = z.strictObject({
  item_id: Uuid,
  superseded_by_item_id: Uuid,
  reason_code: SupersedeReason,
});

export const ItemWithdrawnPayload = z.strictObject({
  item_id: Uuid,
  reason_code: WithdrawReason,
});

export const DependencyPayload = z.strictObject({
  item_id: Uuid,
  depends_on_item_id: Uuid,
});

export const ReviewClearedPayload = z.strictObject({ item_id: Uuid });

export const RequestedItem = z.strictObject({
  item_id: Uuid,
  version: PositiveInt,
  content_hash: Hex64,
});
export type RequestedItem = z.infer<typeof RequestedItem>;

const unique = (values: readonly string[]) => new Set(values).size === values.length;

export const ConfirmationRequestedPayload = z
  .strictObject({
    request_id: Uuid,
    items: z.array(RequestedItem).min(1).max(500),
    contact_ids: z.array(Uuid).min(1).max(100),
    expires_at: IsoTimestamp,
    channel: ConfirmationChannelName,
  })
  .refine((p) => unique(p.items.map((i) => i.item_id)), "an item can appear only once per request")
  .refine((p) => unique(p.contact_ids), "a contact can appear only once per request");

export const ConfirmationRevokedPayload = z.strictObject({
  request_id: Uuid,
  contact_id: Uuid.nullable(),
});

export const AuthorizationPayload = z.strictObject({
  contact_id: Uuid,
  request_id: Uuid,
  text_version: text(1, 64),
  text: text(1, 4000),
  text_sha256: Hex64,
  evidence_commitment: Hex64,
});

export const ItemConfirmedPayload = z.strictObject({
  item_id: Uuid,
  version: PositiveInt,
  content_hash: Hex64,
  contact_id: Uuid,
  request_id: Uuid,
  submission_id: Uuid,
  channel: ConfirmationChannelName,
  evidence_commitment: Hex64,
});

export const ItemDisputedPayload = z.strictObject({
  item_id: Uuid,
  version: PositiveInt,
  content_hash: Hex64,
  contact_id: Uuid,
  request_id: Uuid,
  submission_id: Uuid,
  channel: ConfirmationChannelName,
  evidence_commitment: Hex64,
  comment_commitment: Hex64,
});

export const ContactErasedPayload = z.strictObject({ contact_id: Uuid });

export const eventPayloadSchemas = {
  engagement_created: EngagementCreatedPayload,
  engagement_updated: EngagementUpdatedPayload,
  source_ingested: SourceIngestedPayload,
  source_redacted: SourceRedactedPayload,
  item_created: ItemCreatedPayload,
  item_revised: ItemRevisedPayload,
  item_superseded: ItemSupersededPayload,
  item_withdrawn: ItemWithdrawnPayload,
  dependency_added: DependencyPayload,
  dependency_removed: DependencyPayload,
  review_cleared: ReviewClearedPayload,
  confirmation_requested: ConfirmationRequestedPayload,
  confirmation_revoked: ConfirmationRevokedPayload,
  authorization_granted: AuthorizationPayload,
  authorization_declined: AuthorizationPayload,
  item_confirmed: ItemConfirmedPayload,
  item_disputed: ItemDisputedPayload,
  contact_erased: ContactErasedPayload,
} as const;

export type EventType = keyof typeof eventPayloadSchemas;
export const EVENT_TYPES = Object.keys(eventPayloadSchemas) as EventType[];
export type EventPayload<T extends EventType> = z.infer<(typeof eventPayloadSchemas)[T]>;

export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(eventPayloadSchemas, value);
}

/**
 * Event types whose `occurred_at` is supplied by the caller (the source date, or a member-supplied
 * date for manual items). Every other event has `occurred_at = recorded_at` (ARCHITECTURE §2.2).
 */
export const OCCURRED_AT_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  "source_ingested",
  "item_created",
  "item_revised",
]);

export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Actor, drafts, stored events

export const ACTOR_TYPES = ["user", "contact", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const Actor = z
  .strictObject({ type: z.enum(ACTOR_TYPES), id: Uuid.nullable() })
  .refine((a) => (a.type === "system") === (a.id === null), "system actors have no id; users and contacts do");
export type Actor = z.infer<typeof Actor>;

/**
 * Who may author each event type (enforced by `parseEventDraft`). Client responses and
 * authorizations are authored by the contact they name; retention may redact sources as `system`.
 */
export const EVENT_ACTOR_TYPES: { readonly [T in EventType]: readonly ActorType[] } = {
  engagement_created: ["user"],
  engagement_updated: ["user"],
  source_ingested: ["user"],
  source_redacted: ["user", "system"],
  item_created: ["user"],
  item_revised: ["user"],
  item_superseded: ["user"],
  item_withdrawn: ["user"],
  dependency_added: ["user"],
  dependency_removed: ["user"],
  review_cleared: ["user"],
  confirmation_requested: ["user"],
  confirmation_revoked: ["user", "system"],
  authorization_granted: ["contact"],
  authorization_declined: ["contact"],
  item_confirmed: ["contact"],
  item_disputed: ["contact"],
  contact_erased: ["user", "system"],
};

/**
 * What a command produces. `occurredAt` is used only for `OCCURRED_AT_EVENT_TYPES` (and defaults to
 * the recorded time when absent); for all other types it is ignored and `occurred_at = recorded_at`.
 */
export type EventDraft = {
  [T in EventType]: { type: T; payload: EventPayload<T>; actor: Actor; occurredAt?: Date };
}[EventType];

export interface StoredEventBase {
  orgId: string;
  engagementId: string;
  seq: number;
  schemaVersion: number;
  actor: Actor;
  occurredAt: Date;
  recordedAt: Date;
  prevHash: string;
  hash: string;
}

/** An event row as stored (Dates for timestamps, payload as plain JSON). */
export type StoredEvent = {
  [T in EventType]: StoredEventBase & { type: T; payload: EventPayload<T> };
}[EventType];

export type StoredEventOf<T extends EventType> = Extract<StoredEvent, { type: T }>;
export type EventDraftOf<T extends EventType> = Extract<EventDraft, { type: T }>;

export class EventValidationError extends Error {
  readonly issues: readonly string[];
  constructor(eventType: string, issues: readonly string[]) {
    super(`invalid ${eventType} event: ${issues.join("; ")}`);
    this.name = "EventValidationError";
    this.issues = issues;
  }
}

/** Removes object properties whose value is `undefined` (they cannot survive a jsonb round trip). */
function dropUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropUndefined);
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = dropUndefined(v);
    }
    return out;
  }
  return value;
}

function issuesOf(error: z.ZodError): string[] {
  // Paths and messages only: never echo input values (they may contain statements).
  return error.issues.map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`);
}

/**
 * Validates a draft (type, payload, actor, optional occurredAt). Returns a new draft whose payload
 * has `undefined`-valued keys removed and is otherwise structurally identical to the input. Also
 * asserts the payload is canonical-JSON safe, so hashing cannot fail later.
 */
export function parseEventDraft(input: { type: unknown; payload: unknown; actor: unknown; occurredAt?: unknown }): EventDraft {
  const type = input.type;
  if (!isEventType(type)) throw new EventValidationError("unknown", ["type: unknown event type"]);
  const schema = eventPayloadSchemas[type] as z.ZodType;
  const payload = dropUndefined(input.payload);
  const parsedPayload = schema.safeParse(payload);
  const issues: string[] = [];
  if (!parsedPayload.success) issues.push(...issuesOf(parsedPayload.error).map((m) => `payload.${m}`));
  const parsedActor = Actor.safeParse(input.actor);
  if (!parsedActor.success) issues.push(...issuesOf(parsedActor.error).map((m) => `actor.${m}`));
  else {
    if (!EVENT_ACTOR_TYPES[type].includes(parsedActor.data.type)) issues.push(`actor.type: not allowed for ${type}`);
    const contactId = (payload as { contact_id?: unknown } | null)?.contact_id;
    if (parsedActor.data.type === "contact" && parsedActor.data.id !== contactId) issues.push("actor.id: must be the contact named in the payload");
  }
  if (input.occurredAt !== undefined && !(input.occurredAt instanceof Date && !Number.isNaN(input.occurredAt.getTime()))) {
    issues.push("occurredAt: expected a valid Date");
  }
  if (issues.length > 0) throw new EventValidationError(type, issues);
  canonicalJson(payload);
  const draft = { type, payload, actor: parsedActor.data } as EventDraft;
  if (input.occurredAt !== undefined) draft.occurredAt = new Date((input.occurredAt as Date).getTime());
  return draft;
}
