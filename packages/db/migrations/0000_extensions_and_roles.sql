-- Extensions and roles. Runs as the owner role (veradact_admin), before any table exists.

CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint

-- veradact_app is the only role the apps use (NOSUPERUSER NOBYPASSRLS). In dev the docker
-- init script creates it with LOGIN; in production ops creates it. If it is missing we
-- create it NOLOGIN so grants below still apply; ops then sets a password and LOGIN.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'veradact_app') THEN
    CREATE ROLE veradact_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
