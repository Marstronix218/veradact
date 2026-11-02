// ARCHITECTURE §2.4 — operational tables (mutable, outside the log). They may reference
// only org, app_user, engagement, client_contact and event — never projections — so
// projection ids (source, item, request, extraction run, api token) are plain uuids here.
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { appId, oneOf, tstz } from "./columns";
import {
  candidateStatuses,
  candidateVerifications,
  extractionRunStatuses,
  itemKinds,
  notificationKinds,
  usageEventKinds,
} from "./enums";
import { eventFk } from "./log";
import { appUserFk, clientContactFk, engagementFk, org } from "./tenancy";

/** Normalized source text (offsets refer to `text`). Deleted on redaction. */
export const sourceContent = pgTable(
  "source_content",
  {
    sourceId: uuid("source_id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    engagementId: uuid("engagement_id").notNull(),
    title: text("title"),
    filename: text("filename"),
    text: text("text").notNull(),
    rawText: text("raw_text").notNull(),
    participants: jsonb("participants").notNull().default([]),
    segments: jsonb("segments").notNull().default([]),
  },
  (t) => [
    engagementFk("source_content_engagement_fk", t.engagementId, t.orgId),
    index("source_content_org_idx").on(t.orgId),
    index("source_content_engagement_idx").on(t.engagementId),
  ],
);

/** Optional free-text explanation for an event; erasable, never hashed. */
export const eventNote = pgTable(
  "event_note",
  {
    eventId: bigint("event_id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id").notNull(),
    note: text("note").notNull(),
  },
  (t) => [eventFk("event_note_event_fk", t.eventId, t.orgId), index("event_note_org_idx").on(t.orgId)],
);

/** Ids and counts only. */
export const extractionRun = pgTable(
  "extraction_run",
  {
    id: appId(),
    orgId: uuid("org_id").notNull(),
    engagementId: uuid("engagement_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    status: text("status", { enum: extractionRunStatuses }).notNull(),
    proposedCount: integer("proposed_count").notNull().default(0),
    droppedCount: integer("dropped_count").notNull().default(0),
    correctedCount: integer("corrected_count").notNull().default(0),
    errorCode: text("error_code"),
    createdAt: tstz("created_at").notNull(),
    finishedAt: tstz("finished_at"),
  },
  (t) => [
    engagementFk("extraction_run_engagement_fk", t.engagementId, t.orgId),
    index("extraction_run_org_idx").on(t.orgId),
    index("extraction_run_engagement_idx").on(t.engagementId),
    check("extraction_run_status_check", oneOf("status", extractionRunStatuses)),
  ],
);

/** Review queue of AI-proposed items (D-004). */
export const candidate = pgTable(
  "candidate",
  {
    id: appId(),
    orgId: uuid("org_id").notNull(),
    engagementId: uuid("engagement_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    extractionRunId: uuid("extraction_run_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    kind: text("kind", { enum: itemKinds }).notNull(),
    statement: text("statement").notNull(),
    quote: text("quote").notNull(),
    start: integer("start").notNull(),
    end: integer("end").notNull(),
    speakerLabel: text("speaker_label"),
    suggestedDependsOn: jsonb("suggested_depends_on").notNull().default([]),
    confidence: real("confidence"),
    revisesItemId: uuid("revises_item_id"),
    verification: text("verification", { enum: candidateVerifications }).notNull(),
    status: text("status", { enum: candidateStatuses }).notNull().default("pending"),
    decidedBy: uuid("decided_by"),
    decidedAt: tstz("decided_at"),
    resultingItemId: uuid("resulting_item_id"),
    createdAt: tstz("created_at").notNull(),
  },
  (t) => [
    engagementFk("candidate_engagement_fk", t.engagementId, t.orgId),
    appUserFk("candidate_decided_by_fk", t.decidedBy, t.orgId),
    index("candidate_org_idx").on(t.orgId),
    index("candidate_engagement_idx").on(t.engagementId),
    index("candidate_source_idx").on(t.sourceId),
    check("candidate_kind_check", oneOf("kind", itemKinds)),
    check("candidate_verification_check", oneOf("verification", candidateVerifications)),
    check("candidate_status_check", oneOf("status", candidateStatuses)),
  ],
);

export const confirmationLink = pgTable(
  "confirmation_link",
  {
    id: appId(),
    orgId: uuid("org_id").notNull(),
    engagementId: uuid("engagement_id").notNull(),
    requestId: uuid("request_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    /** Erasable copy of the address the link was sent to. */
    sentToEmail: text("sent_to_email"),
    expiresAt: tstz("expires_at").notNull(),
    revokedAt: tstz("revoked_at"),
    emailSentAt: tstz("email_sent_at"),
    reminderSentAt: tstz("reminder_sent_at"),
    firstOpenedAt: tstz("first_opened_at"),
    lastOpenedAt: tstz("last_opened_at"),
    openCount: integer("open_count").notNull().default(0),
    firstInteractionAt: tstz("first_interaction_at"),
    createdAt: tstz("created_at").notNull(),
  },
  (t) => [
    engagementFk("confirmation_link_engagement_fk", t.engagementId, t.orgId),
    clientContactFk("confirmation_link_contact_fk", t.contactId, t.orgId),
    index("confirmation_link_org_idx").on(t.orgId),
    index("confirmation_link_engagement_idx").on(t.engagementId),
    index("confirmation_link_request_idx").on(t.requestId),
  ],
);

/** Confirmer identity snapshot at response time; erasable. */
export const confirmationEvidence = pgTable(
  "confirmation_evidence",
  {
    eventId: bigint("event_id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [
    eventFk("confirmation_evidence_event_fk", t.eventId, t.orgId),
    clientContactFk("confirmation_evidence_contact_fk", t.contactId, t.orgId),
    index("confirmation_evidence_org_idx").on(t.orgId),
    index("confirmation_evidence_contact_idx").on(t.contactId),
  ],
);

/** Dispute comment text; erasable. */
export const responseComment = pgTable(
  "response_comment",
  {
    eventId: bigint("event_id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    comment: text("comment").notNull(),
  },
  (t) => [
    eventFk("response_comment_event_fk", t.eventId, t.orgId),
    clientContactFk("response_comment_contact_fk", t.contactId, t.orgId),
    index("response_comment_org_idx").on(t.orgId),
    index("response_comment_contact_idx").on(t.contactId),
  ],
);

export const notification = pgTable(
  "notification",
  {
    id: appId(),
    orgId: uuid("org_id").notNull(),
    userId: uuid("user_id").notNull(),
    engagementId: uuid("engagement_id").notNull(),
    kind: text("kind", { enum: notificationKinds }).notNull(),
    itemId: uuid("item_id"),
    contactId: uuid("contact_id"),
    readAt: tstz("read_at"),
    createdAt: tstz("created_at").notNull(),
  },
  (t) => [
    appUserFk("notification_user_fk", t.userId, t.orgId),
    engagementFk("notification_engagement_fk", t.engagementId, t.orgId),
    clientContactFk("notification_contact_fk", t.contactId, t.orgId),
    index("notification_org_idx").on(t.orgId),
    index("notification_engagement_idx").on(t.engagementId),
    index("notification_user_idx").on(t.userId),
    check("notification_kind_check", oneOf("kind", notificationKinds)),
  ],
);

export const usageEvent = pgTable(
  "usage_event",
  {
    id: appId(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    /** Null for org-level calls such as MCP `list_engagements`. */
    engagementId: uuid("engagement_id"),
    kind: text("kind", { enum: usageEventKinds }).notNull(),
    userId: uuid("user_id"),
    apiTokenId: uuid("api_token_id"),
    tool: text("tool"),
    createdAt: tstz("created_at").notNull(),
  },
  (t) => [
    engagementFk("usage_event_engagement_fk", t.engagementId, t.orgId),
    appUserFk("usage_event_user_fk", t.userId, t.orgId),
    index("usage_event_org_idx").on(t.orgId),
    index("usage_event_engagement_idx").on(t.engagementId),
    check("usage_event_kind_check", oneOf("kind", usageEventKinds)),
  ],
);

/** Append-only for the app role (privileges + triggers). Metadata holds ids/enums only. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: appId(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    actorUserId: uuid("actor_user_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: tstz("created_at").notNull(),
  },
  (t) => [
    appUserFk("audit_log_actor_user_fk", t.actorUserId, t.orgId),
    index("audit_log_org_created_at_idx").on(t.orgId, t.createdAt),
  ],
);

/** Fixed-window rate limit counters. No tenant data: the only table without RLS. */
export const rateLimitBucket = pgTable(
  "rate_limit_bucket",
  {
    /** sha256 of the limited key (never the raw IP/email/token). */
    key: text("key").notNull(),
    windowStart: tstz("window_start").notNull(),
    count: integer("count").notNull(),
  },
  (t) => [primaryKey({ name: "rate_limit_bucket_pk", columns: [t.key, t.windowStart] })],
);
