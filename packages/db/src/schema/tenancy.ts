// ARCHITECTURE §2.1 — tenancy and identity (mutable, operational).
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { appId, bytea, citext, oneOf, tstz } from "./columns";
import { DEFAULT_ALL_PARTY_STATES, engagementStatuses, userRoles } from "./enums";

export const org = pgTable("org", {
  id: appId(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique("org_slug_unique"),
  aiEnabled: boolean("ai_enabled").notNull().default(true),
  retentionDays: integer("retention_days"),
  allPartyStates: text("all_party_states")
    .array()
    .notNull()
    .default(sql.raw(`'{${DEFAULT_ALL_PARTY_STATES.join(",")}}'::text[]`)),
  blockUnknownJurisdictions: boolean("block_unknown_jurisdictions").notNull().default(true),
  reminderBusinessDays: integer("reminder_business_days").notNull().default(2),
  createdAt: tstz("created_at").notNull(),
});

export const appUser = pgTable(
  "app_user",
  {
    id: appId(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    email: citext("email").notNull().unique("app_user_email_unique"),
    name: text("name").notNull(),
    role: text("role", { enum: userRoles }).notNull(),
    deactivatedAt: tstz("deactivated_at"),
    createdAt: tstz("created_at").notNull(),
  },
  (t) => [
    unique("app_user_id_org_unique").on(t.id, t.orgId),
    index("app_user_org_idx").on(t.orgId),
    check("app_user_role_check", oneOf("role", userRoles)),
  ],
);

/** Composite `(user_id, org_id) → app_user(id, org_id)`: a row can never point into another tenant. */
export const appUserFk = (name: string, userId: AnyPgColumn, orgId: AnyPgColumn) =>
  foreignKey({ name, columns: [userId, orgId], foreignColumns: [appUser.id, appUser.orgId] });

export const loginToken = pgTable(
  "login_token",
  {
    id: appId(),
    orgId: uuid("org_id").notNull(),
    userId: uuid("user_id").notNull(),
    tokenHash: text("token_hash").notNull().unique("login_token_token_hash_unique"),
    expiresAt: tstz("expires_at").notNull(),
    usedAt: tstz("used_at"),
    createdAt: tstz("created_at").notNull(),
  },
  (t) => [
    appUserFk("login_token_user_fk", t.userId, t.orgId),
    index("login_token_org_idx").on(t.orgId),
    index("login_token_user_idx").on(t.userId),
  ],
);

export const session = pgTable(
  "session",
  {
    id: appId(),
    orgId: uuid("org_id").notNull(),
    userId: uuid("user_id").notNull(),
    tokenHash: text("token_hash").notNull().unique("session_token_hash_unique"),
    expiresAt: tstz("expires_at").notNull(),
    revokedAt: tstz("revoked_at"),
    lastSeenAt: tstz("last_seen_at"),
    createdAt: tstz("created_at").notNull(),
  },
  (t) => [
    appUserFk("session_user_fk", t.userId, t.orgId),
    index("session_org_idx").on(t.orgId),
    index("session_user_idx").on(t.userId),
  ],
);

export const apiToken = pgTable(
  "api_token",
  {
    id: appId(),
    orgId: uuid("org_id").notNull(),
    userId: uuid("user_id").notNull(),
    name: text("name").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    tokenHash: text("token_hash").notNull().unique("api_token_token_hash_unique"),
    lastUsedAt: tstz("last_used_at"),
    revokedAt: tstz("revoked_at"),
    createdAt: tstz("created_at").notNull(),
  },
  (t) => [
    appUserFk("api_token_user_fk", t.userId, t.orgId),
    index("api_token_org_idx").on(t.orgId),
    index("api_token_user_idx").on(t.userId),
  ],
);

export const engagement = pgTable(
  "engagement",
  {
    id: appId(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    name: text("name").notNull(),
    clientName: text("client_name").notNull(),
    /** Immutable once created. */
    shortCode: text("short_code").notNull(),
    timeZone: text("time_zone").notNull(),
    aiEnabled: boolean("ai_enabled").notNull().default(true),
    /**
     * Email domains the client uses (lower case, sorted). When set, adding a contact outside them
     * needs an explicit acknowledgement, which is audited (D-057). Empty = no check.
     */
    clientEmailDomains: text("client_email_domains").array().notNull().default(sql`'{}'::text[]`),
    status: text("status", { enum: engagementStatuses }).notNull().default("active"),
    createdBy: uuid("created_by").notNull(),
    createdAt: tstz("created_at").notNull(),
    archivedAt: tstz("archived_at"),
  },
  (t) => [
    unique("engagement_id_org_unique").on(t.id, t.orgId),
    unique("engagement_org_short_code_unique").on(t.orgId, t.shortCode),
    appUserFk("engagement_created_by_fk", t.createdBy, t.orgId),
    check("engagement_short_code_check", sql`"short_code" ~ '^[A-Z0-9]{2,8}$'`),
    check("engagement_status_check", oneOf("status", engagementStatuses)),
  ],
);

/** Composite `(engagement_id, org_id) → engagement(id, org_id)`. */
export const engagementFk = (name: string, engagementId: AnyPgColumn, orgId: AnyPgColumn) =>
  foreignKey({
    name,
    columns: [engagementId, orgId],
    foreignColumns: [engagement.id, engagement.orgId],
  });

/** No PII: the id is the subject id used in events. */
export const clientContact = pgTable(
  "client_contact",
  {
    id: appId(),
    orgId: uuid("org_id").notNull(),
    engagementId: uuid("engagement_id").notNull(),
    createdAt: tstz("created_at").notNull(),
    erasedAt: tstz("erased_at"),
  },
  (t) => [
    unique("client_contact_id_org_unique").on(t.id, t.orgId),
    engagementFk("client_contact_engagement_fk", t.engagementId, t.orgId),
    index("client_contact_org_idx").on(t.orgId),
    index("client_contact_engagement_idx").on(t.engagementId),
  ],
);

/** Composite `(contact_id, org_id) → client_contact(id, org_id)`. */
export const clientContactFk = (name: string, contactId: AnyPgColumn, orgId: AnyPgColumn) =>
  foreignKey({
    name,
    columns: [contactId, orgId],
    foreignColumns: [clientContact.id, clientContact.orgId],
  });

/** Erasable (§6): deleting the row destroys the contact's HMAC key. */
export const contactPii = pgTable(
  "contact_pii",
  {
    contactId: uuid("contact_id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    title: text("title"),
    hmacKey: bytea("hmac_key").notNull(),
  },
  (t) => [
    clientContactFk("contact_pii_contact_fk", t.contactId, t.orgId),
    index("contact_pii_org_idx").on(t.orgId),
    check("contact_pii_hmac_key_check", sql`octet_length("hmac_key") = 32`),
  ],
);
