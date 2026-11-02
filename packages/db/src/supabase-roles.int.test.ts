// Supabase API roles (D-061, migration 0006). anon, authenticated and service_role cannot use
// schema public or any Veradact object in it, so the Data API (PostgREST, pg_graphql) serves
// nothing even when it is switched on. The test database gets a real public schema's grants
// and Supabase's default privileges on reset (reset-test-db.ts), so these tests fail if a
// migration lets the roles back in.
import { randomUUID } from "node:crypto";
import { sql, TransactionRollbackError } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { adminTestDb, catchPgError } from "./testing";

const admin = adminTestDb();

afterAll(async () => {
  await admin.close();
});

const API_ROLES = ["anon", "authenticated", "service_role"] as const;
const INSUFFICIENT_PRIVILEGE = "42501";

const list = (names: readonly string[]) =>
  sql.join(
    names.map((n) => sql`${n}`),
    sql`, `,
  );
const apiRoleList = list(API_ROLES);
/** The API roles plus the PUBLIC pseudo-role, which every role inherits from. */
const apiRolesAndPublic = sql`array[${list([...API_ROLES, "public"])}]::text[]`;

describe("Supabase API roles", () => {
  it("exist (tests run against the local Supabase stack from `pnpm db:up`)", async () => {
    const rows = await admin.db.execute<{ rolname: string }>(sql`
      select rolname from pg_roles where rolname in (${apiRoleList}) order by rolname`);
    expect(rows.map((r) => r.rolname)).toEqual([...API_ROLES].sort());
  });

  it("cannot use schema public, whoever owns the objects in it", async () => {
    const rows = await admin.db.execute<{ role: string }>(sql`
      select r as role from unnest(${apiRolesAndPublic}) r where has_schema_privilege(r, 'public', 'USAGE')`);
    expect(rows).toEqual([]);
    const [app] = await admin.db.execute<{ usage: boolean }>(sql`
      select has_schema_privilege('veradact_app', 'public', 'USAGE') as usage`);
    expect(app).toEqual({ usage: true });
  });

  it("hold no privilege on any table, view, column or sequence in public, and neither does PUBLIC", async () => {
    const [{ relations } = { relations: 0 }] = await admin.db.execute<{ relations: number }>(sql`
      select count(*) as relations from pg_class
       where relnamespace = 'public'::regnamespace and relkind in ('r', 'p', 'v', 'm', 'f', 'S')`);
    expect(relations).toBeGreaterThan(25);

    const grants = await admin.db.execute<{ relname: string; role: string }>(sql`
      select c.relname, r as role
        from pg_class c cross join unnest(${apiRolesAndPublic}) r
       where c.relnamespace = 'public'::regnamespace
         and case when c.relkind = 'S'
                  then has_sequence_privilege(r, c.oid, 'USAGE, SELECT, UPDATE')
                  else has_table_privilege(r, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                       or has_any_column_privilege(r, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
             end
         and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')`);
    expect(grants).toEqual([]);
  });

  it("cannot execute any SECURITY DEFINER function, and hold no direct grant on our functions", async () => {
    const [{ definers } = { definers: 0 }] = await admin.db.execute<{ definers: number }>(sql`
      select count(*) as definers from pg_proc where pronamespace = 'public'::regnamespace and prosecdef`);
    expect(definers).toBeGreaterThanOrEqual(7);

    const executable = await admin.db.execute<{ fn: string; role: string }>(sql`
      select p.oid::regprocedure::text as fn, r as role
        from pg_proc p cross join unnest(${apiRolesAndPublic}) r
       where p.pronamespace = 'public'::regnamespace and p.prosecdef
         and has_function_privilege(r, p.oid, 'EXECUTE')`);
    expect(executable).toEqual([]);

    // Extension members (citext) are owned by Supabase, not by the migrations; the schema
    // revoke above is what keeps them out of reach.
    const direct = await admin.db.execute<{ fn: string; grantee: string }>(sql`
      select p.oid::regprocedure::text as fn, pg_get_userbyid(a.grantee) as grantee
        from pg_proc p, aclexplode(p.proacl) a
       where p.pronamespace = 'public'::regnamespace
         and not exists (select 1 from pg_depend d
                          where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
         and pg_get_userbyid(a.grantee) in (${apiRoleList})`);
    expect(direct).toEqual([]);
  });

  it("get nothing on objects a later migration creates (default privileges)", async () => {
    const name = `probe_${randomUUID().replaceAll("-", "")}`;
    let granted: { relations: boolean; fn: boolean }[] = [];
    // Created as the migration role and rolled back, so no other test ever sees the objects.
    const outcome = await admin.db
      .transaction(async (tx) => {
        await tx.execute(sql.raw(`create table public.${name} (id int generated always as identity)`));
        await tx.execute(sql.raw(`create function public.${name}() returns int language sql as 'select 1'`));
        granted = await tx.execute<{ relations: boolean; fn: boolean }>(sql`
          select exists (select 1 from pg_class c, aclexplode(c.relacl) a
                          where c.oid in (${`public.${name}`}::regclass,
                                          pg_get_serial_sequence(${`public.${name}`}, 'id')::regclass)
                            and pg_get_userbyid(a.grantee) in (${apiRoleList})) as relations,
                 exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                          where p.oid = ${`public.${name}()`}::regprocedure
                            and pg_get_userbyid(a.grantee) in (${apiRoleList})) as fn`);
        tx.rollback();
      })
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(TransactionRollbackError);
    expect(granted).toEqual([{ relations: false, fn: false }]);
  });

  it.each(API_ROLES)("%s is refused by the database", async (role) => {
    // Schema-qualified, as PostgREST sends them: without USAGE on public, an unqualified name
    // does not even resolve.
    const probes = [
      "select 1 from public.event limit 1",
      "select 1 from public.contact_pii limit 1",
      "insert into public.rate_limit_bucket (key, window_start, count) values ('probe', now(), 1)",
      "select * from public.auth_find_user_by_email('probe@example.test')",
      "select * from public.jobs_list_org_ids()",
    ];
    for (const probe of probes) {
      const error = await catchPgError(
        admin.db.transaction(async (tx) => {
          await tx.execute(sql.raw(`set local role ${role}`));
          // A failed SET ROLE is also 42501; make sure the probe really runs as the role.
          const [who] = await tx.execute<{ current_user: string }>(sql`select current_user`);
          if (who?.current_user !== role) throw new Error(`expected to run as ${role}, ran as ${who?.current_user}`);
          await tx.execute(sql.raw(probe));
        }),
      );
      expect({ probe, code: error.code }).toEqual({ probe, code: INSUFFICIENT_PRIVILEGE });
      expect(error.message).toMatch(/^permission denied for (schema|table|function) /);
    }
  });
});

describe("rate_limit_bucket", () => {
  it("has RLS with one policy, for the app role only", async () => {
    const [row] = await admin.db.execute<{ rls: boolean; policies: { name: string; roles: string[] }[] }>(sql`
      select c.relrowsecurity as rls,
             (select json_agg(json_build_object(
                       'name', p.polname,
                       'roles', array(select pg_get_userbyid(r) from unnest(p.polroles) r)))
                from pg_policy p where p.polrelid = c.oid) as policies
        from pg_class c where c.oid = 'public.rate_limit_bucket'::regclass`);
    expect(row).toEqual({ rls: true, policies: [{ name: "app_role_only", roles: ["veradact_app"] }] });
  });
});
