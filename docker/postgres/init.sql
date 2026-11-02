-- Runs once, on first initialisation of the data directory, as veradact_admin.
-- veradact_app is the runtime role: RLS is enforced (NOBYPASSRLS).
-- Table-level grants come later from migrations.

CREATE ROLE veradact_app WITH
  LOGIN
  PASSWORD 'veradact_app'
  NOSUPERUSER
  NOBYPASSRLS
  NOCREATEDB
  NOCREATEROLE;

CREATE DATABASE veradact_test OWNER veradact_admin;

GRANT CONNECT ON DATABASE veradact TO veradact_app;
GRANT CONNECT ON DATABASE veradact_test TO veradact_app;
