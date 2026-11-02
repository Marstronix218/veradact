// Tenant isolation of the shared export loaders (`@veradact/export/server`, used by this server and
// the web app's downloads): in org A's tenant transaction, org B's engagement and item ids behave
// exactly like ids that never existed, and org B is unchanged. Lives here because core cannot
// import export; the core commands and queries are covered in core's cross-tenant.int.test.ts.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isCoreError } from "@veradact/core";
import { withTenant, type Tx } from "@veradact/db";
import { adminTestDb, testDb } from "@veradact/db/testing";
import { loadExportContext, loadRecord, loadSpec, resolveEngagementRef, resolveItemRef } from "@veradact/export/server";
import { createExportScenario, type ExportScenario } from "@veradact/export/server/testing";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

const clock = () => new Date("2026-11-01T14:00:00.000Z");

let A: ExportScenario;
let B: ExportScenario;
let before: unknown[][];

/** All of org B's events and the engagement head (admin connection, bypasses RLS). */
async function snapshot(orgId: string): Promise<unknown[][]> {
  return [
    [...(await admin.sql`select * from event where org_id = ${orgId} order by id`)],
    [...(await admin.sql`select * from engagement_head where org_id = ${orgId}`)],
    [...(await admin.sql`select * from usage_event where org_id = ${orgId} order by id`)],
  ];
}

beforeAll(async () => {
  [A, B] = await Promise.all([createExportScenario(app, admin.db), createExportScenario(app, admin.db)]);
  before = await snapshot(B.orgId);
}, 60_000);

const inA = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app.db, { orgId: A.orgId, userId: A.userId }, fn);

async function outcome(fn: (tx: Tx) => Promise<unknown>): Promise<string> {
  return inA(fn).then(
    (value) => (value === null ? "null" : "resolved"),
    (error: unknown) => (isCoreError(error) ? `${error.constructor.name}:${error.code}` : "unexpected"),
  );
}

describe("export loaders across tenants", () => {
  const cases: [string, () => string, (tx: Tx, id: string) => Promise<unknown>, string][] = [
    ["resolveEngagementRef", () => B.engagementId, (tx, id) => resolveEngagementRef(tx, id), "null"],
    ["resolveItemRef", () => B.items.r1.itemId, (tx, id) => resolveItemRef(tx, id), "null"],
    ["loadExportContext", () => B.engagementId, (tx, id) => loadExportContext(tx, { engagementId: id, clock }), "NotFoundError:not_found"],
    ["loadSpec", () => B.engagementId, (tx, id) => loadSpec(tx, { engagementId: id, clock }), "NotFoundError:not_found"],
    ["loadRecord", () => B.engagementId, (tx, id) => loadRecord(tx, { engagementId: id, clock }), "NotFoundError:not_found"],
  ];

  it.each(cases)("%s answers for org B's id exactly as for an unknown id", async (_name, foreign, run, expected) => {
    expect(await outcome((tx) => run(tx, foreign()))).toBe(expected);
    expect(await outcome((tx) => run(tx, randomUUID()))).toBe(expected);
  });

  it("leaves org B unchanged", async () => {
    expect(before[0]!.length).toBeGreaterThan(0);
    expect(await snapshot(B.orgId)).toEqual(before);
  });
});
