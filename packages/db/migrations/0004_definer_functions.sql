-- Pre-tenant lookups (ARCHITECTURE §7). Narrow SECURITY DEFINER functions owned by the
-- migration role (veradact_admin, which bypasses RLS as table owner). Each pins
-- search_path, is executable only by veradact_app and returns ids plus the minimum the
-- caller needs. Everything else happens afterwards inside withTenant().

-- Login: active user for an email (case-insensitive).
CREATE FUNCTION auth_find_user_by_email(p_email text)
  RETURNS TABLE (user_id uuid, org_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.org_id
    FROM app_user u
   WHERE u.email = p_email::citext
     AND u.deactivated_at IS NULL
$$;
--> statement-breakpoint

-- Magic link: single use. The UPDATE ... WHERE used_at IS NULL claims the token atomically,
-- so concurrent calls with the same hash return a row at most once.
CREATE FUNCTION auth_consume_login_token(p_token_hash text)
  RETURNS TABLE (login_token_id uuid, user_id uuid, org_id uuid)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  UPDATE login_token t
     SET used_at = now()
    FROM app_user u
   WHERE t.token_hash = p_token_hash
     AND t.used_at IS NULL
     AND t.expires_at > now()
     AND u.id = t.user_id
     AND u.org_id = t.org_id
     AND u.deactivated_at IS NULL
  RETURNING t.id, t.user_id, t.org_id
$$;
--> statement-breakpoint

-- Session cookie -> user. Revoked, expired and deactivated-user sessions do not resolve.
CREATE FUNCTION auth_resolve_session(p_token_hash text)
  RETURNS TABLE (session_id uuid, user_id uuid, org_id uuid, role text, expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT s.id, s.user_id, s.org_id, u.role, s.expires_at
    FROM session s
    JOIN app_user u ON u.id = s.user_id AND u.org_id = s.org_id
   WHERE s.token_hash = p_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
     AND u.deactivated_at IS NULL
$$;
--> statement-breakpoint

-- MCP bearer token -> user. Revoked tokens and deactivated users do not resolve.
CREATE FUNCTION auth_resolve_api_token(p_token_hash text)
  RETURNS TABLE (api_token_id uuid, user_id uuid, org_id uuid, role text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.user_id, t.org_id, u.role
    FROM api_token t
    JOIN app_user u ON u.id = t.user_id AND u.org_id = t.org_id
   WHERE t.token_hash = p_token_hash
     AND t.revoked_at IS NULL
     AND u.deactivated_at IS NULL
$$;
--> statement-breakpoint

-- Client link -> tenant + binding. Returned even when expired or revoked: the caller
-- checks the signature first and renders the same "no longer valid" page for every failure.
CREATE FUNCTION link_resolve(p_link_id uuid)
  RETURNS TABLE (
    link_id uuid, org_id uuid, engagement_id uuid, request_id uuid, contact_id uuid,
    expires_at timestamptz, revoked_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT l.id, l.org_id, l.engagement_id, l.request_id, l.contact_id, l.expires_at, l.revoked_at
    FROM confirmation_link l
   WHERE l.id = p_link_id
$$;
--> statement-breakpoint

-- Jobs iterate orgs, then do all work per org inside withTenant().
CREATE FUNCTION jobs_list_org_ids()
  RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT o.id FROM org o ORDER BY o.id
$$;
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION
  auth_find_user_by_email(text),
  auth_consume_login_token(text),
  auth_resolve_session(text),
  auth_resolve_api_token(text),
  link_resolve(uuid),
  jobs_list_org_ids()
FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION
  auth_find_user_by_email(text),
  auth_consume_login_token(text),
  auth_resolve_session(text),
  auth_resolve_api_token(text),
  link_resolve(uuid),
  jobs_list_org_ids()
TO veradact_app;
