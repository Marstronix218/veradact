CREATE TABLE "api_token" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"last_used_at" timestamp (3) with time zone,
	"revoked_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "api_token_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"email" "citext" NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"deactivated_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "app_user_email_unique" UNIQUE("email"),
	CONSTRAINT "app_user_id_org_unique" UNIQUE("id","org_id"),
	CONSTRAINT "app_user_role_check" CHECK ("role" in ('admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"extraction_run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" text NOT NULL,
	"statement" text NOT NULL,
	"quote" text NOT NULL,
	"start" integer NOT NULL,
	"end" integer NOT NULL,
	"speaker_label" text,
	"suggested_depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real,
	"revises_item_id" uuid,
	"verification" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp (3) with time zone,
	"resulting_item_id" uuid,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "candidate_kind_check" CHECK ("kind" in ('problem', 'constraint', 'assumption', 'decision', 'requirement')),
	CONSTRAINT "candidate_verification_check" CHECK ("verification" in ('exact', 'offset_corrected')),
	CONSTRAINT "candidate_status_check" CHECK ("status" in ('pending', 'accepted', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "client_contact" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"erased_at" timestamp (3) with time zone,
	CONSTRAINT "client_contact_id_org_unique" UNIQUE("id","org_id")
);
--> statement-breakpoint
CREATE TABLE "confirmation_evidence" (
	"event_id" bigint PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "confirmation_link" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"sent_to_email" text,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	"email_sent_at" timestamp (3) with time zone,
	"reminder_sent_at" timestamp (3) with time zone,
	"first_opened_at" timestamp (3) with time zone,
	"last_opened_at" timestamp (3) with time zone,
	"open_count" integer DEFAULT 0 NOT NULL,
	"first_interaction_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "confirmation_request" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"recorded_at" timestamp (3) with time zone NOT NULL,
	"event_seq" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "confirmation_request_contact" (
	"org_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	CONSTRAINT "confirmation_request_contact_pk" PRIMARY KEY("request_id","contact_id")
);
--> statement-breakpoint
CREATE TABLE "confirmation_request_item" (
	"org_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content_hash" char(64) NOT NULL,
	CONSTRAINT "confirmation_request_item_pk" PRIMARY KEY("request_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "contact_authorization" (
	"org_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"contact_id" uuid PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"text_version" text NOT NULL,
	"text_sha256" char(64) NOT NULL,
	"recorded_at" timestamp (3) with time zone NOT NULL,
	"event_seq" bigint NOT NULL,
	CONSTRAINT "contact_authorization_decision_check" CHECK ("decision" in ('granted', 'declined'))
);
--> statement-breakpoint
CREATE TABLE "contact_pii" (
	"contact_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"title" text,
	"hmac_key" "bytea" NOT NULL,
	CONSTRAINT "contact_pii_hmac_key_check" CHECK (octet_length("hmac_key") = 32)
);
--> statement-breakpoint
CREATE TABLE "engagement" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"client_name" text NOT NULL,
	"short_code" text NOT NULL,
	"time_zone" text NOT NULL,
	"ai_enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"archived_at" timestamp (3) with time zone,
	CONSTRAINT "engagement_id_org_unique" UNIQUE("id","org_id"),
	CONSTRAINT "engagement_org_short_code_unique" UNIQUE("org_id","short_code"),
	CONSTRAINT "engagement_short_code_check" CHECK ("short_code" ~ '^[A-Z0-9]{2,8}$'),
	CONSTRAINT "engagement_status_check" CHECK ("status" in ('active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "engagement_head" (
	"engagement_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"head_seq" bigint NOT NULL,
	"head_hash" char(64) NOT NULL,
	"head_recorded_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"org_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"type" text NOT NULL,
	"schema_version" smallint NOT NULL,
	"payload" jsonb NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"recorded_at" timestamp (3) with time zone NOT NULL,
	"prev_hash" char(64) NOT NULL,
	"hash" char(64) NOT NULL,
	CONSTRAINT "event_engagement_seq_unique" UNIQUE("engagement_id","seq"),
	CONSTRAINT "event_hash_unique" UNIQUE("hash"),
	CONSTRAINT "event_id_org_unique" UNIQUE("id","org_id"),
	CONSTRAINT "event_seq_check" CHECK ("seq" >= 1),
	CONSTRAINT "event_schema_version_check" CHECK ("schema_version" >= 1),
	CONSTRAINT "event_actor_type_check" CHECK ("actor_type" in ('user', 'contact', 'system')),
	CONSTRAINT "event_prev_hash_check" CHECK ("prev_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "event_hash_check" CHECK ("hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "event_note" (
	"event_id" bigint PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"note" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extraction_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"status" text NOT NULL,
	"proposed_count" integer DEFAULT 0 NOT NULL,
	"dropped_count" integer DEFAULT 0 NOT NULL,
	"corrected_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"finished_at" timestamp (3) with time zone,
	CONSTRAINT "extraction_run_status_check" CHECK ("status" in ('running', 'succeeded', 'failed', 'discarded'))
);
--> statement-breakpoint
CREATE TABLE "item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"short_id" text NOT NULL,
	"kind" text NOT NULL,
	"current_version" integer NOT NULL,
	"status" text NOT NULL,
	"lifecycle" text NOT NULL,
	"superseded_by" uuid,
	"needs_review" boolean NOT NULL,
	"review_reasons" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	"last_seq" bigint NOT NULL,
	CONSTRAINT "item_engagement_short_id_unique" UNIQUE("engagement_id","short_id"),
	CONSTRAINT "item_kind_check" CHECK ("kind" in ('problem', 'constraint', 'assumption', 'decision', 'requirement')),
	CONSTRAINT "item_status_check" CHECK ("status" in ('pending', 'confirmed', 'disputed')),
	CONSTRAINT "item_lifecycle_check" CHECK ("lifecycle" in ('active', 'superseded', 'withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "item_dependency" (
	"org_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"depends_on_item_id" uuid NOT NULL,
	"added_seq" bigint NOT NULL,
	CONSTRAINT "item_dependency_pk" PRIMARY KEY("item_id","depends_on_item_id")
);
--> statement-breakpoint
CREATE TABLE "item_response" (
	"org_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"event_seq" bigint NOT NULL,
	"item_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content_hash" char(64) NOT NULL,
	"contact_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"response" text NOT NULL,
	"comment_commitment" text,
	"recorded_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "item_response_pk" PRIMARY KEY("engagement_id","event_seq"),
	CONSTRAINT "item_response_response_check" CHECK ("response" in ('confirmed', 'disputed'))
);
--> statement-breakpoint
CREATE TABLE "item_version" (
	"item_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"org_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"content_hash" char(64) NOT NULL,
	"statement" text NOT NULL,
	"spans" jsonb NOT NULL,
	"manual" jsonb,
	"provenance" jsonb NOT NULL,
	"reason_code" text,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"recorded_at" timestamp (3) with time zone NOT NULL,
	"event_seq" bigint NOT NULL,
	CONSTRAINT "item_version_pk" PRIMARY KEY("item_id","version"),
	CONSTRAINT "item_version_reason_code_check" CHECK ("reason_code" is null or "reason_code" in ('client_dispute', 'new_information', 'correction', 'scope_change', 'other'))
);
--> statement-breakpoint
CREATE TABLE "login_token" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"used_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "login_token_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"item_id" uuid,
	"contact_id" uuid,
	"read_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "notification_kind_check" CHECK ("kind" in ('item_disputed', 'authorization_declined'))
);
--> statement-breakpoint
CREATE TABLE "org" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"ai_enabled" boolean DEFAULT true NOT NULL,
	"retention_days" integer,
	"all_party_states" text[] DEFAULT '{CA,CT,DE,FL,IL,MD,MA,MT,NV,NH,OR,PA,WA}'::text[] NOT NULL,
	"block_unknown_jurisdictions" boolean DEFAULT true NOT NULL,
	"reminder_business_days" integer DEFAULT 2 NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "org_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "rate_limit_bucket" (
	"key" text NOT NULL,
	"window_start" timestamp (3) with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "rate_limit_bucket_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "response_comment" (
	"event_id" bigint PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"comment" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	"last_seen_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "session_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "source" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"format" text NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"recorded_at" timestamp (3) with time zone NOT NULL,
	"content_sha256" char(64) NOT NULL,
	"char_length" integer NOT NULL,
	"participant_count" integer NOT NULL,
	"attestation" jsonb NOT NULL,
	"ingested_by" uuid NOT NULL,
	"redacted_at" timestamp (3) with time zone,
	"redaction_reason" text,
	CONSTRAINT "source_source_type_check" CHECK ("source_type" in ('human_notes', 'machine_transcript', 'email', 'chat_export')),
	CONSTRAINT "source_format_check" CHECK ("format" in ('txt', 'md', 'vtt', 'srt', 'docx', 'paste')),
	CONSTRAINT "source_redaction_reason_check" CHECK ("redaction_reason" is null or "redaction_reason" in ('user_request', 'retention', 'consent_withdrawn', 'uploaded_in_error', 'other'))
);
--> statement-breakpoint
CREATE TABLE "source_content" (
	"source_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"title" text,
	"filename" text,
	"text" text NOT NULL,
	"raw_text" text NOT NULL,
	"participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"segments" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"engagement_id" uuid,
	"kind" text NOT NULL,
	"user_id" uuid,
	"api_token_id" uuid,
	"tool" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "usage_event_kind_check" CHECK ("kind" in ('spec_export', 'record_export_md', 'record_export_pdf', 'mcp_fetch'))
);
--> statement-breakpoint
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_user_fk" FOREIGN KEY ("user_id","org_id") REFERENCES "public"."app_user"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_fk" FOREIGN KEY ("actor_user_id","org_id") REFERENCES "public"."app_user"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate" ADD CONSTRAINT "candidate_engagement_fk" FOREIGN KEY ("engagement_id","org_id") REFERENCES "public"."engagement"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate" ADD CONSTRAINT "candidate_decided_by_fk" FOREIGN KEY ("decided_by","org_id") REFERENCES "public"."app_user"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_contact" ADD CONSTRAINT "client_contact_engagement_fk" FOREIGN KEY ("engagement_id","org_id") REFERENCES "public"."engagement"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confirmation_evidence" ADD CONSTRAINT "confirmation_evidence_event_fk" FOREIGN KEY ("event_id","org_id") REFERENCES "public"."event"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confirmation_evidence" ADD CONSTRAINT "confirmation_evidence_contact_fk" FOREIGN KEY ("contact_id","org_id") REFERENCES "public"."client_contact"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confirmation_link" ADD CONSTRAINT "confirmation_link_engagement_fk" FOREIGN KEY ("engagement_id","org_id") REFERENCES "public"."engagement"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confirmation_link" ADD CONSTRAINT "confirmation_link_contact_fk" FOREIGN KEY ("contact_id","org_id") REFERENCES "public"."client_contact"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confirmation_request" ADD CONSTRAINT "confirmation_request_engagement_fk" FOREIGN KEY ("engagement_id","org_id") REFERENCES "public"."engagement"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confirmation_request_contact" ADD CONSTRAINT "confirmation_request_contact_engagement_fk" FOREIGN KEY ("engagement_id","org_id") REFERENCES "public"."engagement"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confirmation_request_item" ADD CONSTRAINT "confirmation_request_item_engagement_fk" FOREIGN KEY ("engagement_id","org_id") REFERENCES "public"."engagement"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_authorization" ADD CONSTRAINT "contact_authorization_engagement_fk" FOREIGN KEY ("engagement_id","org_id") REFERENCES "public"."engagement"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_pii" ADD CONSTRAINT "contact_pii_contact_fk" FOREIGN KEY ("contact_id","org_id") REFERENCES "public"."client_contact"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_created_by_fk" FOREIGN KEY ("created_by","org_id") REFERENCES "public"."app_user"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_head" ADD CONSTRAINT "engagement_head_engagement_fk" FOREIGN KEY ("engagement_id","org_id") REFERENCES "public"."engagement"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_engagement_fk" FOREIGN KEY ("engagement_id","org_id") REFERENCES "public"."engagement"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_note" ADD CONSTRAINT "event_note_event_fk" FOREIGN KEY ("event_id","org_id") REFERENCES "public"."event"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_run" ADD CONSTRAINT "extraction_run_engagement_fk" FOREIGN KEY ("engagement_id","org_id") REFERENCES "public"."engagement"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item" ADD CONSTRAINT "item_engagement_fk" FOREIGN KEY ("engagement_id","org_id") REFERENCES "public"."engagement"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_dependency" ADD CONSTRAINT "item_dependency_engagement_fk" FOREIGN KEY ("engagement_id","org_id") REFERENCES "public"."engagement"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_response" ADD CONSTRAINT "item_response_engagement_fk" FOREIGN KEY ("engagement_id","org_id") REFERENCES "public"."engagement"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_version" ADD CONSTRAINT "item_version_engagement_fk" FOREIGN KEY ("engagement_id","org_id") REFERENCES "public"."engagement"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_token" ADD CONSTRAINT "login_token_user_fk" FOREIGN KEY ("user_id","org_id") REFERENCES "public"."app_user"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_user_fk" FOREIGN KEY ("user_id","org_id") REFERENCES "public"."app_user"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_engagement_fk" FOREIGN KEY ("engagement_id","org_id") REFERENCES "public"."engagement"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_contact_fk" FOREIGN KEY ("contact_id","org_id") REFERENCES "public"."client_contact"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_comment" ADD CONSTRAINT "response_comment_event_fk" FOREIGN KEY ("event_id","org_id") REFERENCES "public"."event"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_comment" ADD CONSTRAINT "response_comment_contact_fk" FOREIGN KEY ("contact_id","org_id") REFERENCES "public"."client_contact"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_fk" FOREIGN KEY ("user_id","org_id") REFERENCES "public"."app_user"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_engagement_fk" FOREIGN KEY ("engagement_id","org_id") REFERENCES "public"."engagement"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_content" ADD CONSTRAINT "source_content_engagement_fk" FOREIGN KEY ("engagement_id","org_id") REFERENCES "public"."engagement"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_engagement_fk" FOREIGN KEY ("engagement_id","org_id") REFERENCES "public"."engagement"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_user_fk" FOREIGN KEY ("user_id","org_id") REFERENCES "public"."app_user"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_token_org_idx" ON "api_token" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "api_token_user_idx" ON "api_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "app_user_org_idx" ON "app_user" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "audit_log_org_created_at_idx" ON "audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "candidate_org_idx" ON "candidate" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "candidate_engagement_idx" ON "candidate" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "candidate_source_idx" ON "candidate" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "client_contact_org_idx" ON "client_contact" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "client_contact_engagement_idx" ON "client_contact" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "confirmation_evidence_org_idx" ON "confirmation_evidence" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "confirmation_evidence_contact_idx" ON "confirmation_evidence" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "confirmation_link_org_idx" ON "confirmation_link" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "confirmation_link_engagement_idx" ON "confirmation_link" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "confirmation_link_request_idx" ON "confirmation_link" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "confirmation_request_org_idx" ON "confirmation_request" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "confirmation_request_engagement_idx" ON "confirmation_request" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "confirmation_request_contact_org_idx" ON "confirmation_request_contact" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "confirmation_request_contact_engagement_idx" ON "confirmation_request_contact" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "confirmation_request_item_org_idx" ON "confirmation_request_item" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "confirmation_request_item_engagement_idx" ON "confirmation_request_item" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "contact_authorization_org_idx" ON "contact_authorization" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "contact_authorization_engagement_idx" ON "contact_authorization" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "contact_pii_org_idx" ON "contact_pii" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "engagement_head_org_idx" ON "engagement_head" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "event_org_idx" ON "event" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "event_engagement_recorded_at_idx" ON "event" USING btree ("engagement_id","recorded_at");--> statement-breakpoint
CREATE INDEX "event_note_org_idx" ON "event_note" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "extraction_run_org_idx" ON "extraction_run" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "extraction_run_engagement_idx" ON "extraction_run" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "item_org_idx" ON "item" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "item_dependency_org_idx" ON "item_dependency" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "item_dependency_engagement_idx" ON "item_dependency" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "item_dependency_depends_on_idx" ON "item_dependency" USING btree ("depends_on_item_id");--> statement-breakpoint
CREATE INDEX "item_response_org_idx" ON "item_response" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "item_response_item_idx" ON "item_response" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "item_version_org_idx" ON "item_version" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "item_version_engagement_idx" ON "item_version" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "login_token_org_idx" ON "login_token" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "login_token_user_idx" ON "login_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notification_org_idx" ON "notification" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "notification_engagement_idx" ON "notification" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "notification_user_idx" ON "notification" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "response_comment_org_idx" ON "response_comment" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "response_comment_contact_idx" ON "response_comment" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "session_org_idx" ON "session" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "source_org_idx" ON "source" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "source_engagement_idx" ON "source" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "source_content_org_idx" ON "source_content" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "source_content_engagement_idx" ON "source_content" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "usage_event_org_idx" ON "usage_event" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "usage_event_engagement_idx" ON "usage_event" USING btree ("engagement_id");