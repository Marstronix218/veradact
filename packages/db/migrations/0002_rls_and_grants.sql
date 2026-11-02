-- Tenant isolation (ARCHITECTURE §7) and privileges for the app role.

-- The tenant of the current transaction, set by withTenant() via
-- set_config('app.org_id', <uuid>, true). No setting (or '') -> NULL -> no rows.
CREATE FUNCTION app_current_org() RETURNS uuid
  LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;
--> statement-breakpoint

-- org is keyed by id.
ALTER TABLE org ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON org
  USING (id = app_current_org())
  WITH CHECK (id = app_current_org());
--> statement-breakpoint

-- Every other tenant table is keyed by org_id. rate_limit_bucket holds no tenant data
-- and is the only table without RLS. The catalog sweep test fails on any public table
-- missing from this list.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- tenancy and identity
    'app_user', 'login_token', 'session', 'api_token', 'engagement', 'client_contact', 'contact_pii',
    -- log
    'event', 'engagement_head',
    -- projections
    'source', 'item', 'item_version', 'item_dependency', 'item_response', 'confirmation_request',
    'confirmation_request_item', 'confirmation_request_contact', 'contact_authorization',
    -- operational
    'source_content', 'event_note', 'extraction_run', 'candidate', 'confirmation_link',
    'confirmation_evidence', 'response_comment', 'notification', 'usage_event', 'audit_log'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())',
      t
    );
  END LOOP;
END
$$;
--> statement-breakpoint

-- Privileges. The owner (veradact_admin) bypasses RLS; veradact_app does not.
GRANT USAGE ON SCHEMA public TO veradact_app;
--> statement-breakpoint

-- Orgs are created only by `pnpm org:create` (admin URL); the app reads and updates settings.
GRANT SELECT, UPDATE ON org TO veradact_app;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON
  app_user, login_token, session, api_token, engagement, client_contact, contact_pii,
  source, item, item_version, item_dependency, item_response, confirmation_request,
  confirmation_request_item, confirmation_request_contact, contact_authorization,
  source_content, event_note, extraction_run, candidate, confirmation_link,
  confirmation_evidence, response_comment, notification, usage_event, rate_limit_bucket
TO veradact_app;
--> statement-breakpoint

-- Append-only: SELECT and INSERT only, enforced again by triggers in 0003.
GRANT SELECT, INSERT ON event, audit_log TO veradact_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON event, audit_log FROM veradact_app, PUBLIC;
--> statement-breakpoint

-- Maintained only by the event insert trigger (SECURITY DEFINER).
GRANT SELECT ON engagement_head TO veradact_app;
--> statement-breakpoint

-- Identity columns do not need sequence privileges for INSERT, but explicit nextval/currval
-- (and any future serial column) do.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO veradact_app;
