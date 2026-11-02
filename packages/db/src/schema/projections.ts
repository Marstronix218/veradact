// ARCHITECTURE §2.3 — projections, rebuildable from the log (§5). Written only by the
// projection writer. Nothing references these tables and nothing cascades into them;
// their only foreign key is the composite engagement key, which pins the tenant.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { oneOf, tstz } from "./columns";
import {
  authorizationDecisions,
  clientResponses,
  itemKinds,
  itemLifecycles,
  itemStatuses,
  redactionReasonCodes,
  revisionReasonCodes,
  sourceFormats,
  sourceTypes,
} from "./enums";
import { engagementFk } from "./tenancy";

export const source = pgTable(
  "source",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    engagementId: uuid("engagement_id").notNull(),
    sourceType: text("source_type", { enum: sourceTypes }).notNull(),
    format: text("format", { enum: sourceFormats }).notNull(),
    occurredAt: tstz("occurred_at").notNull(),
    recordedAt: tstz("recorded_at").notNull(),
    contentSha256: char("content_sha256", { length: 64 }).notNull(),
    charLength: integer("char_length").notNull(),
    participantCount: integer("participant_count").notNull(),
    attestation: jsonb("attestation").notNull(),
    ingestedBy: uuid("ingested_by").notNull(),
    redactedAt: tstz("redacted_at"),
    redactionReason: text("redaction_reason", { enum: redactionReasonCodes }),
  },
  (t) => [
    engagementFk("source_engagement_fk", t.engagementId, t.orgId),
    index("source_org_idx").on(t.orgId),
    index("source_engagement_idx").on(t.engagementId),
    check("source_source_type_check", oneOf("source_type", sourceTypes)),
    check("source_format_check", oneOf("format", sourceFormats)),
    check(
      "source_redaction_reason_check",
      sql`"redaction_reason" is null or ${oneOf("redaction_reason", redactionReasonCodes)}`,
    ),
  ],
);

export const item = pgTable(
  "item",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    engagementId: uuid("engagement_id").notNull(),
    shortId: text("short_id").notNull(),
    kind: text("kind", { enum: itemKinds }).notNull(),
    currentVersion: integer("current_version").notNull(),
    status: text("status", { enum: itemStatuses }).notNull(),
    lifecycle: text("lifecycle", { enum: itemLifecycles }).notNull(),
    supersededBy: uuid("superseded_by"),
    needsReview: boolean("needs_review").notNull(),
    reviewReasons: jsonb("review_reasons").notNull(),
    createdAt: tstz("created_at").notNull(),
    updatedAt: tstz("updated_at").notNull(),
    lastSeq: bigint("last_seq", { mode: "number" }).notNull(),
  },
  (t) => [
    unique("item_engagement_short_id_unique").on(t.engagementId, t.shortId),
    engagementFk("item_engagement_fk", t.engagementId, t.orgId),
    index("item_org_idx").on(t.orgId),
    check("item_kind_check", oneOf("kind", itemKinds)),
    check("item_status_check", oneOf("status", itemStatuses)),
    check("item_lifecycle_check", oneOf("lifecycle", itemLifecycles)),
  ],
);

export const itemVersion = pgTable(
  "item_version",
  {
    itemId: uuid("item_id").notNull(),
    version: integer("version").notNull(),
    orgId: uuid("org_id").notNull(),
    engagementId: uuid("engagement_id").notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    statement: text("statement").notNull(),
    spans: jsonb("spans").notNull(),
    manual: jsonb("manual"),
    provenance: jsonb("provenance").notNull(),
    reasonCode: text("reason_code", { enum: revisionReasonCodes }),
    occurredAt: tstz("occurred_at").notNull(),
    recordedAt: tstz("recorded_at").notNull(),
    eventSeq: bigint("event_seq", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ name: "item_version_pk", columns: [t.itemId, t.version] }),
    engagementFk("item_version_engagement_fk", t.engagementId, t.orgId),
    index("item_version_org_idx").on(t.orgId),
    index("item_version_engagement_idx").on(t.engagementId),
    check(
      "item_version_reason_code_check",
      sql`"reason_code" is null or ${oneOf("reason_code", revisionReasonCodes)}`,
    ),
  ],
);

export const itemDependency = pgTable(
  "item_dependency",
  {
    orgId: uuid("org_id").notNull(),
    engagementId: uuid("engagement_id").notNull(),
    itemId: uuid("item_id").notNull(),
    dependsOnItemId: uuid("depends_on_item_id").notNull(),
    addedSeq: bigint("added_seq", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ name: "item_dependency_pk", columns: [t.itemId, t.dependsOnItemId] }),
    engagementFk("item_dependency_engagement_fk", t.engagementId, t.orgId),
    index("item_dependency_org_idx").on(t.orgId),
    index("item_dependency_engagement_idx").on(t.engagementId),
    index("item_dependency_depends_on_idx").on(t.dependsOnItemId),
  ],
);

export const itemResponse = pgTable(
  "item_response",
  {
    orgId: uuid("org_id").notNull(),
    engagementId: uuid("engagement_id").notNull(),
    eventSeq: bigint("event_seq", { mode: "number" }).notNull(),
    itemId: uuid("item_id").notNull(),
    version: integer("version").notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    contactId: uuid("contact_id").notNull(),
    requestId: uuid("request_id").notNull(),
    submissionId: uuid("submission_id").notNull(),
    response: text("response", { enum: clientResponses }).notNull(),
    commentCommitment: text("comment_commitment"),
    recordedAt: tstz("recorded_at").notNull(),
  },
  (t) => [
    primaryKey({ name: "item_response_pk", columns: [t.engagementId, t.eventSeq] }),
    engagementFk("item_response_engagement_fk", t.engagementId, t.orgId),
    index("item_response_org_idx").on(t.orgId),
    index("item_response_item_idx").on(t.itemId),
    check("item_response_response_check", oneOf("response", clientResponses)),
  ],
);

export const confirmationRequest = pgTable(
  "confirmation_request",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    engagementId: uuid("engagement_id").notNull(),
    requestedBy: uuid("requested_by").notNull(),
    expiresAt: tstz("expires_at").notNull(),
    recordedAt: tstz("recorded_at").notNull(),
    eventSeq: bigint("event_seq", { mode: "number" }).notNull(),
  },
  (t) => [
    engagementFk("confirmation_request_engagement_fk", t.engagementId, t.orgId),
    index("confirmation_request_org_idx").on(t.orgId),
    index("confirmation_request_engagement_idx").on(t.engagementId),
  ],
);

export const confirmationRequestItem = pgTable(
  "confirmation_request_item",
  {
    orgId: uuid("org_id").notNull(),
    engagementId: uuid("engagement_id").notNull(),
    requestId: uuid("request_id").notNull(),
    itemId: uuid("item_id").notNull(),
    version: integer("version").notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
  },
  (t) => [
    primaryKey({ name: "confirmation_request_item_pk", columns: [t.requestId, t.itemId] }),
    engagementFk("confirmation_request_item_engagement_fk", t.engagementId, t.orgId),
    index("confirmation_request_item_org_idx").on(t.orgId),
    index("confirmation_request_item_engagement_idx").on(t.engagementId),
  ],
);

export const confirmationRequestContact = pgTable(
  "confirmation_request_contact",
  {
    orgId: uuid("org_id").notNull(),
    engagementId: uuid("engagement_id").notNull(),
    requestId: uuid("request_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    revokedAt: tstz("revoked_at"),
  },
  (t) => [
    primaryKey({
      name: "confirmation_request_contact_pk",
      columns: [t.requestId, t.contactId],
    }),
    engagementFk("confirmation_request_contact_engagement_fk", t.engagementId, t.orgId),
    index("confirmation_request_contact_org_idx").on(t.orgId),
    index("confirmation_request_contact_engagement_idx").on(t.engagementId),
  ],
);

/** Latest decision per contact (the reducer keeps only the latest). */
export const contactAuthorization = pgTable(
  "contact_authorization",
  {
    orgId: uuid("org_id").notNull(),
    engagementId: uuid("engagement_id").notNull(),
    contactId: uuid("contact_id").primaryKey(),
    requestId: uuid("request_id").notNull(),
    decision: text("decision", { enum: authorizationDecisions }).notNull(),
    textVersion: text("text_version").notNull(),
    textSha256: char("text_sha256", { length: 64 }).notNull(),
    recordedAt: tstz("recorded_at").notNull(),
    eventSeq: bigint("event_seq", { mode: "number" }).notNull(),
  },
  (t) => [
    engagementFk("contact_authorization_engagement_fk", t.engagementId, t.orgId),
    index("contact_authorization_org_idx").on(t.orgId),
    index("contact_authorization_engagement_idx").on(t.engagementId),
    check("contact_authorization_decision_check", oneOf("decision", authorizationDecisions)),
  ],
);
