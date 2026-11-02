-- Append-only enforcement and chain linkage for the log (ARCHITECTURE §2.2, D-007).
-- Hash *content* is computed and verified in TypeScript; the database guarantees seq
-- continuity, prev_hash linkage, monotonic recorded_at and immutability.

-- Rejects UPDATE/DELETE (row) and TRUNCATE (statement) for every role, owner included.
-- TG_ARGV[0] is the message. Tests simulate tampering by disabling these triggers as owner.
CREATE FUNCTION reject_append_only_mutation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '%', TG_ARGV[0] USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION reject_append_only_mutation() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER event_append_only_row
  BEFORE UPDATE OR DELETE ON event
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation('event log is append-only');
--> statement-breakpoint
CREATE TRIGGER event_append_only_truncate
  BEFORE TRUNCATE ON event
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation('event log is append-only');
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only_row
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation('audit log is append-only');
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation('audit log is append-only');
--> statement-breakpoint

-- Chain linkage. SECURITY DEFINER (owned by the migration role, veradact_admin) because
-- the app role can only SELECT engagement_head. FOR UPDATE serializes concurrent writers
-- of one engagement; the append API additionally holds an advisory lock (§5.2).
-- Messages carry no head values: this trigger runs before the RLS WITH CHECK, so an
-- insert aimed at another tenant must not learn anything about that tenant's chain.
CREATE FUNCTION event_check_chain() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  head engagement_head%ROWTYPE;
BEGIN
  SELECT * INTO head FROM engagement_head WHERE engagement_id = NEW.engagement_id FOR UPDATE;

  IF NOT FOUND THEN
    IF NEW.seq <> 1 OR NEW.prev_hash <> repeat('0', 64) THEN
      RAISE EXCEPTION 'event chain: genesis event must have seq 1 and a zero prev_hash'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    INSERT INTO engagement_head (engagement_id, org_id, head_seq, head_hash, head_recorded_at)
      VALUES (NEW.engagement_id, NEW.org_id, NEW.seq, NEW.hash, NEW.recorded_at);
    RETURN NEW;
  END IF;

  IF NEW.seq <> head.head_seq + 1 THEN
    RAISE EXCEPTION 'event chain: seq does not follow the engagement head'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.prev_hash <> head.head_hash THEN
    RAISE EXCEPTION 'event chain: prev_hash does not match the engagement head'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.recorded_at < head.head_recorded_at THEN
    RAISE EXCEPTION 'event chain: recorded_at precedes the engagement head'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  UPDATE engagement_head
     SET head_seq = NEW.seq, head_hash = NEW.hash, head_recorded_at = NEW.recorded_at
   WHERE engagement_id = NEW.engagement_id;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION event_check_chain() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER event_check_chain
  BEFORE INSERT ON event
  FOR EACH ROW EXECUTE FUNCTION event_check_chain();
