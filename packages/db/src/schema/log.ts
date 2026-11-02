// ARCHITECTURE §2.2 — the append-only, hash-chained log. Linkage and immutability are
// enforced by triggers and privileges in the hand-written migrations.
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  char,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { oneOf, tstz } from "./columns";
import { actorTypes } from "./enums";
import { engagementFk } from "./tenancy";

/** Genesis `prev_hash`. */
export const ZERO_HASH = "0".repeat(64);

export const event = pgTable(
  "event",
  {
    /** Global insert order; not semantic, not hashed. */
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: uuid("org_id").notNull(),
    engagementId: uuid("engagement_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    schemaVersion: smallint("schema_version").notNull(),
    payload: jsonb("payload").notNull(),
    actorType: text("actor_type", { enum: actorTypes }).notNull(),
    actorId: uuid("actor_id"),
    occurredAt: tstz("occurred_at").notNull(),
    recordedAt: tstz("recorded_at").notNull(),
    prevHash: char("prev_hash", { length: 64 }).notNull(),
    hash: char("hash", { length: 64 }).notNull(),
  },
  (t) => [
    unique("event_engagement_seq_unique").on(t.engagementId, t.seq),
    unique("event_hash_unique").on(t.hash),
    unique("event_id_org_unique").on(t.id, t.orgId),
    engagementFk("event_engagement_fk", t.engagementId, t.orgId),
    index("event_org_idx").on(t.orgId),
    index("event_engagement_recorded_at_idx").on(t.engagementId, t.recordedAt),
    check("event_seq_check", sql`"seq" >= 1`),
    check("event_schema_version_check", sql`"schema_version" >= 1`),
    check("event_actor_type_check", oneOf("actor_type", actorTypes)),
    check("event_prev_hash_check", sql`"prev_hash" ~ '^[0-9a-f]{64}$'`),
    check("event_hash_check", sql`"hash" ~ '^[0-9a-f]{64}$'`),
  ],
);

/** Composite `(event_id, org_id) → event(id, org_id)`. */
export const eventFk = (name: string, eventId: AnyPgColumn, orgId: AnyPgColumn) =>
  foreignKey({ name, columns: [eventId, orgId], foreignColumns: [event.id, event.orgId] });

/** Maintained only by the event insert trigger; the app role can SELECT it. */
export const engagementHead = pgTable(
  "engagement_head",
  {
    engagementId: uuid("engagement_id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    headSeq: bigint("head_seq", { mode: "number" }).notNull(),
    headHash: char("head_hash", { length: 64 }).notNull(),
    headRecordedAt: tstz("head_recorded_at").notNull(),
  },
  (t) => [
    engagementFk("engagement_head_engagement_fk", t.engagementId, t.orgId),
    index("engagement_head_org_idx").on(t.orgId),
  ],
);
