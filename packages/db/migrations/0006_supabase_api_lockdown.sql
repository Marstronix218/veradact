-- Supabase API roles (D-061). A Supabase project gives anon, authenticated and service_role
-- every privilege on whatever its postgres role creates in public (default privileges), and the
-- Data API (PostgREST, pg_graphql) acts as those roles. Veradact never uses them: revoke what
-- they hold on our objects and on the schema itself, and stop later migrations from granting it
-- again. The role loop is a no-op on plain Postgres, where the roles do not exist.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END
$$;
--> statement-breakpoint

-- Only the owner and the app role may use public at all. Objects other roles create here stay
-- unreachable even when their owner's default privileges grant the API roles everything: on
-- Supabase, extensions are installed by supabase_admin, whose defaults the migration role cannot
-- change.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO veradact_app;
--> statement-breakpoint

-- rate_limit_bucket holds no tenant data and so has no tenant policy, but RLS still confines it
-- to the app role: any other role that is ever granted access sees and changes nothing.
ALTER TABLE rate_limit_bucket ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY app_role_only ON rate_limit_bucket TO veradact_app USING (true) WITH CHECK (true);
