// Invariant 1 (append-only) and the database half of invariant 3 (chain linkage).
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { auditLog, engagementHead, event, ZERO_HASH } from "./schema";
import { withTenant } from "./tenant";
import {
  adminTestDb,
  catchPgError,
  createTestTenant,
  insertRawEvents,
  randomHash,
  testDb,
  type TestEvent,
} from "./testing";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

const INSUFFICIENT_PRIVILEGE = "42501";
const RESTRICT_VIOLATION = "23001";
const INTEGRITY_CONSTRAINT_VIOLATION = "23000";

function headOf(row: TestEvent) {
  return { seq: row.seq, hash: row.hash, recordedAt: row.recordedAt };
}

/** A tenant whose engagement already has `count` events, inserted by the app role. */
async function tenantWithEvents(count: number) {
  const tenant = await createTestTenant(admin.db);
  const target = { orgId: tenant.org.id, engagementId: tenant.engagement.id };
  const events = await withTenant(app.db, { orgId: tenant.org.id }, (tx) =>
    insertRawEvents(tx, target, count),
  );
  return { ...tenant, target, events };
}

describe("event insert trigger (chain linkage)", () => {
  it("accepts a linked chain and keeps engagement_head at the latest event", async () => {
    const { org, target, events } = await tenantWithEvents(3);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events[0]?.prevHash).toBe(ZERO_HASH);
    expect(events[1]?.prevHash).toBe(events[0]?.hash);

    const heads = await withTenant(app.db, { orgId: org.id }, (tx) =>
      tx.select().from(engagementHead).where(eq(engagementHead.engagementId, target.engagementId)),
    );
    const last = events[2];
    expect(heads).toEqual([
      {
        engagementId: target.engagementId,
        orgId: org.id,
        headSeq: 3,
        headHash: last?.hash,
        headRecordedAt: last?.recordedAt,
      },
    ]);
  });

  it("rejects a genesis event whose seq is not 1", async () => {
    const { org, engagement } = await createTestTenant(admin.db);
    const error = await catchPgError(
      withTenant(app.db, { orgId: org.id }, (tx) =>
        insertRawEvents(tx, { orgId: org.id, engagementId: engagement.id }, 1, { seq: 2 }),
      ),
    );
    expect(error.code).toBe(INTEGRITY_CONSTRAINT_VIOLATION);
    expect(error.message).toMatch(/genesis/);
  });

  it("rejects a genesis event whose prev_hash is not 64 zeros", async () => {
    const { org, engagement } = await createTestTenant(admin.db);
    const error = await catchPgError(
      withTenant(app.db, { orgId: org.id }, (tx) =>
        insertRawEvents(tx, { orgId: org.id, engagementId: engagement.id }, 1, { prevHash: randomHash() }),
      ),
    );
    expect(error.code).toBe(INTEGRITY_CONSTRAINT_VIOLATION);
    expect(error.message).toMatch(/genesis/);
  });

  it("rejects a seq gap and a repeated seq", async () => {
    const { org, target, events } = await tenantWithEvents(2);
    const head = headOf(events[1]!);
    for (const seq of [head.seq + 2, head.seq]) {
      const error = await catchPgError(
        withTenant(app.db, { orgId: org.id }, (tx) =>
          insertRawEvents(tx, { ...target, head }, 1, { seq }),
        ),
      );
      expect(error.code).toBe(INTEGRITY_CONSTRAINT_VIOLATION);
      expect(error.message).toMatch(/seq does not follow/);
    }
  });

  it("rejects a prev_hash that is not the head hash", async () => {
    const { org, target, events } = await tenantWithEvents(2);
    const head = headOf(events[1]!);
    for (const prevHash of [randomHash(), events[0]!.hash, ZERO_HASH]) {
      const error = await catchPgError(
        withTenant(app.db, { orgId: org.id }, (tx) =>
          insertRawEvents(tx, { ...target, head }, 1, { prevHash }),
        ),
      );
      expect(error.code).toBe(INTEGRITY_CONSTRAINT_VIOLATION);
      expect(error.message).toMatch(/prev_hash does not match/);
    }
  });

  it("rejects recorded_at going backwards and accepts an equal recorded_at", async () => {
    const { org, target, events } = await tenantWithEvents(1);
    const head = headOf(events[0]!);
    const earlier = new Date(head.recordedAt.getTime() - 1);
    const error = await catchPgError(
      withTenant(app.db, { orgId: org.id }, (tx) =>
        insertRawEvents(tx, { ...target, head }, 1, { recordedAt: earlier, occurredAt: earlier }),
      ),
    );
    expect(error.code).toBe(INTEGRITY_CONSTRAINT_VIOLATION);
    expect(error.message).toMatch(/recorded_at precedes/);

    const [same] = await withTenant(app.db, { orgId: org.id }, (tx) =>
      insertRawEvents(tx, { ...target, head }, 1, { recordedAt: head.recordedAt }),
    );
    expect(same?.seq).toBe(2);
  });

  it("rolls the head back with a failed insert", async () => {
    const { org, target, events } = await tenantWithEvents(1);
    const head = headOf(events[0]!);
    // The trigger advances the head, then the statement fails on the unique hash.
    await catchPgError(
      withTenant(app.db, { orgId: org.id }, (tx) =>
        insertRawEvents(tx, { ...target, head }, 1, { hash: head.hash }),
      ),
    );
    const [row] = await admin.db
      .select()
      .from(engagementHead)
      .where(eq(engagementHead.engagementId, target.engagementId));
    expect(row?.headSeq).toBe(1);
    expect(row?.headHash).toBe(head.hash);
  });
});

describe("event is append-only", () => {
  it("app role cannot UPDATE, DELETE or TRUNCATE (privileges)", async () => {
    const { org, events } = await tenantWithEvents(1);
    const id = events[0]!.id;
    const attempts = [
      sql`update event set type = 'tampered' where id = ${id}`,
      sql`delete from event where id = ${id}`,
      sql`truncate event`,
    ];
    for (const statement of attempts) {
      const error = await catchPgError(
        withTenant(app.db, { orgId: org.id }, (tx) => tx.execute(statement)),
      );
      expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
      expect(error.message).toMatch(/permission denied/);
    }
  });

  it("triggers reject UPDATE and DELETE even for the owner", async () => {
    const { events } = await tenantWithEvents(1);
    const id = events[0]!.id;
    const attempts = [
      sql`update event set type = 'tampered' where id = ${id}`,
      sql`delete from event where id = ${id}`,
    ];
    for (const statement of attempts) {
      // Rolled back regardless, so a missing trigger could never change other tests' rows.
      const error = await catchPgError(
        admin.db.transaction(async (tx) => {
          await tx.execute(statement);
          tx.rollback();
        }),
      );
      expect(error.code).toBe(RESTRICT_VIOLATION);
      expect(error.message).toBe("event log is append-only");
    }
    const [row] = await admin.db.select().from(event).where(eq(event.id, id));
    expect(row?.type).toBe("test_event");
  });

  // A live `TRUNCATE event CASCADE` would take ACCESS EXCLUSIVE locks on event and every
  // table referencing it, which can deadlock with concurrent test files. The owner-level
  // TRUNCATE behaviour is exercised on audit_log (same trigger function, one lock); here we
  // check that event carries the same triggers, enabled.
  it("event and audit_log carry enabled append-only and chain triggers", async () => {
    const rows = await admin.db.execute<{ definition: string; enabled: string }>(sql`
      select pg_get_triggerdef(t.oid) as definition, t.tgenabled::text as enabled
        from pg_trigger t
       where t.tgrelid in ('public.event'::regclass, 'public.audit_log'::regclass)
         and not t.tgisinternal`);
    const fn = (message: string) => `EXECUTE FUNCTION reject_append_only_mutation('${message}')`;
    expect(rows.map((r) => r.enabled)).toEqual(rows.map(() => "O"));
    expect(rows.map((r) => r.definition).sort()).toEqual(
      [
        `CREATE TRIGGER audit_log_append_only_row BEFORE DELETE OR UPDATE ON public.audit_log FOR EACH ROW ${fn("audit log is append-only")}`,
        `CREATE TRIGGER audit_log_append_only_truncate BEFORE TRUNCATE ON public.audit_log FOR EACH STATEMENT ${fn("audit log is append-only")}`,
        "CREATE TRIGGER event_check_chain BEFORE INSERT ON public.event FOR EACH ROW EXECUTE FUNCTION event_check_chain()",
        `CREATE TRIGGER event_append_only_row BEFORE DELETE OR UPDATE ON public.event FOR EACH ROW ${fn("event log is append-only")}`,
        `CREATE TRIGGER event_append_only_truncate BEFORE TRUNCATE ON public.event FOR EACH STATEMENT ${fn("event log is append-only")}`,
      ].sort(),
    );
  });

  it("app role can read engagement_head but never write it", async () => {
    const { org, engagement } = await tenantWithEvents(1);
    const attempts = [
      sql`insert into engagement_head (engagement_id, org_id, head_seq, head_hash, head_recorded_at)
          values (${randomUUID()}, ${org.id}, 1, ${ZERO_HASH}, now())`,
      sql`update engagement_head set head_seq = 99 where engagement_id = ${engagement.id}`,
      sql`delete from engagement_head where engagement_id = ${engagement.id}`,
    ];
    for (const statement of attempts) {
      const error = await catchPgError(
        withTenant(app.db, { orgId: org.id }, (tx) => tx.execute(statement)),
      );
      expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    }
    const heads = await withTenant(app.db, { orgId: org.id }, (tx) =>
      tx.select().from(engagementHead).where(eq(engagementHead.engagementId, engagement.id)),
    );
    expect(heads[0]?.headSeq).toBe(1);
  });
});

describe("audit_log is append-only", () => {
  async function tenantWithAuditRow() {
    const tenant = await createTestTenant(admin.db);
    const [row] = await withTenant(app.db, { orgId: tenant.org.id, userId: tenant.user.id }, (tx) =>
      tx
        .insert(auditLog)
        .values({
          orgId: tenant.org.id,
          actorUserId: tenant.user.id,
          action: "engagement.create",
          targetType: "engagement",
          targetId: tenant.engagement.id,
          metadata: { short_code: tenant.engagement.shortCode },
          createdAt: new Date(),
        })
        .returning(),
    );
    return { ...tenant, row: row! };
  }

  it("app role can insert and read its own org's rows", async () => {
    const { org, row } = await tenantWithAuditRow();
    const rows = await withTenant(app.db, { orgId: org.id }, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.id, row.id)),
    );
    expect(rows).toEqual([row]);
  });

  it("app role cannot UPDATE, DELETE or TRUNCATE (privileges)", async () => {
    const { org, row } = await tenantWithAuditRow();
    const attempts = [
      sql`update audit_log set action = 'tampered' where id = ${row.id}`,
      sql`delete from audit_log where id = ${row.id}`,
      sql`truncate audit_log`,
    ];
    for (const statement of attempts) {
      const error = await catchPgError(
        withTenant(app.db, { orgId: org.id }, (tx) => tx.execute(statement)),
      );
      expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it("triggers reject UPDATE, DELETE and TRUNCATE even for the owner", async () => {
    const { row } = await tenantWithAuditRow();
    const attempts = [
      sql`update audit_log set action = 'tampered' where id = ${row.id}`,
      sql`delete from audit_log where id = ${row.id}`,
      sql`truncate audit_log`,
    ];
    for (const statement of attempts) {
      const error = await catchPgError(
        admin.db.transaction(async (tx) => {
          await tx.execute(statement);
          tx.rollback();
        }),
      );
      expect(error.code).toBe(RESTRICT_VIOLATION);
      expect(error.message).toBe("audit log is append-only");
    }
  });
});
