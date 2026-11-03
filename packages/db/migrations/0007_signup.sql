-- Self-serve sign-up (D-062). The app role may not INSERT into org (0002), so a verified
-- sign-up creates the org and its first admin through this one narrow definer function.
-- AI starts off for these orgs (invariant 9; an admin can turn it on in settings). A unique
-- violation (the email already belongs to a user, or a slug collision) rolls back both inserts
-- and returns no row, so the caller never sees a half-created tenant.
CREATE FUNCTION signup_create_org(
  p_org_id uuid, p_org_name text, p_slug text,
  p_user_id uuid, p_email text, p_user_name text,
  p_created_at timestamptz
)
  RETURNS TABLE (org_id uuid, user_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  BEGIN
    INSERT INTO org (id, name, slug, ai_enabled, created_at)
      VALUES (p_org_id, p_org_name, p_slug, false, p_created_at);
    INSERT INTO app_user (id, org_id, email, name, role, created_at)
      VALUES (p_user_id, p_org_id, p_email, p_user_name, 'admin', p_created_at);
  EXCEPTION WHEN unique_violation THEN
    RETURN;
  END;
  org_id := p_org_id;
  user_id := p_user_id;
  RETURN NEXT;
END
$$;
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION
  signup_create_org(uuid, text, text, uuid, text, text, timestamptz)
FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION
  signup_create_org(uuid, text, text, uuid, text, text, timestamptz)
TO veradact_app;
