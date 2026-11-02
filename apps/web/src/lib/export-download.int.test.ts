// The spec and record download routes (`app/api/engagements/[id]/export/*` → `exportDownload`)
// against the test database (app role, RLS enforced): auth, tenant isolation, usage + audit rows,
// and what each artifact contains. Engagements come from the shared export scenario.
import { afterAll, describe, expect, it } from "vitest";
import { readEvents } from "@veradact/core";
import { withTenant } from "@veradact/db";
import { adminTestDb, testDb } from "@veradact/db/testing";
import { NOT_CONFIRMED_HEADING } from "@veradact/export";
import { createExportScenario, type ExportScenario } from "@veradact/export/server/testing";
import { exportDownload, type ExportDownloadKind } from "./export-download";

const app = testDb({ max: 4 });
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

/** After the scenario's last response (2026-03-10), in the engagement's time zone a Friday. */
const NOW = new Date("2026-03-20T15:00:00.000Z");
const clock = () => NOW;

const scenario = createExportScenario(app, admin.db);

function download(s: ExportScenario, kind: ExportDownloadKind, options: { asOf?: string; engagementRef?: string; auth?: { orgId: string; userId: string } | null } = {}) {
  return exportDownload({
    db: app.db,
    auth: options.auth === undefined ? { orgId: s.orgId, userId: s.userId } : options.auth,
    engagementRef: options.engagementRef ?? s.engagementId,
    kind,
    asOf: options.asOf ?? null,
    clock,
  });
}

async function usageKinds(orgId: string): Promise<string[]> {
  const rows = await admin.sql<{ kind: string }[]>`select kind from usage_event where org_id = ${orgId} order by id`;
  return rows.map((r) => r.kind);
}

async function auditRows(orgId: string) {
  const rows = await admin.sql<{ action: string; actor_user_id: string | null; target_id: string | null; metadata: Record<string, unknown> }[]>`
    select action, actor_user_id, target_id, metadata from audit_log where org_id = ${orgId} and action like 'export.%' order by id`;
  return rows.map((r) => ({ action: r.action, actorUserId: r.actor_user_id, targetId: r.target_id, metadata: r.metadata }));
}

describe("export downloads", () => {
  it("require a session and hide other orgs' engagements (404, nothing written)", async () => {
    const s = await scenario;
    const other = await createExportScenario(app, admin.db);
    const before = await usageKinds(s.orgId);

    const anonymous = await download(s, "record_pdf", { auth: null });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("cache-control")).toBe("no-store");

    for (const kind of ["spec", "record_md", "record_pdf"] as const) {
      const res = await download(s, kind, { auth: { orgId: other.orgId, userId: other.userId } });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("Not found.\n");
    }
    expect((await download(s, "spec", { engagementRef: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    expect((await download(s, "spec", { engagementRef: "not an id" })).status).toBe(404);

    expect(await usageKinds(other.orgId)).toEqual([]);
    expect(await auditRows(other.orgId)).toEqual([]);
    expect(await usageKinds(s.orgId)).toEqual(before);
  }, 60_000);

  it("spec.md: only confirmed items plus the do-not-build list; usage + audit export.spec", async () => {
    const s = await scenario;
    const res = await download(s, "spec");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${s.shortCode}-spec-2026-03-20.md"`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();

    const [confirmedPart, notConfirmedPart] = body.split(`## ${NOT_CONFIRMED_HEADING}`);
    expect(notConfirmedPart).toBeDefined();
    const { r1, d1, r2, a1, c1 } = s.items;
    for (const item of [r1, d1]) expect(confirmedPart).toContain(`### ${item.shortId} · ${item.statement}`);
    for (const item of [r2, a1, c1]) {
      expect(confirmedPart).not.toContain(item.statement);
      expect(notConfirmedPart).toContain(`- ${item.shortId} · ${item.statement}`);
    }
    for (const item of [r1, d1]) expect(notConfirmedPart).not.toContain(item.statement);

    expect((await usageKinds(s.orgId)).filter((k) => k === "spec_export").length).toBeGreaterThanOrEqual(1);
    const audit = (await auditRows(s.orgId)).filter((r) => r.action === "export.spec");
    expect(audit.at(-1)).toMatchObject({ actorUserId: s.userId, targetId: s.engagementId, metadata: { as_of: false, item_count: 2 } });
  }, 60_000);

  it("spec.md?as_of=: the agreed view at the end of that local day; a bad as_of is a 400 with nothing written", async () => {
    const s = await scenario;
    // Mar 2 (local) ends before the first confirmations (Mar 3, 15:00Z): nothing is agreed yet.
    const early = await download(s, "spec", { asOf: "2026-03-02" });
    expect(early.status).toBe(200);
    expect(early.headers.get("content-disposition")).toBe(`attachment; filename="${s.shortCode}-spec-2026-03-02.md"`);
    const earlyBody = await early.text();
    expect(earlyBody).toContain('as_of: "2026-03-03T04:59:59.999Z"');
    expect(earlyBody).not.toContain(`### ${s.items.r1.shortId}`);
    expect(earlyBody.split(`## ${NOT_CONFIRMED_HEADING}`)[1]).toContain(`- ${s.items.r1.shortId} · ${s.items.r1.statement} (pending)`);
    // Mar 3 (local) includes R1's confirmations but not D1's (Mar 10).
    const mid = await (await download(s, "spec", { asOf: "2026-03-03" })).text();
    expect(mid).toContain(`### ${s.items.r1.shortId}`);
    expect(mid).not.toContain(`### ${s.items.d1.shortId}`);

    const usageBefore = await usageKinds(s.orgId);
    const auditBefore = await auditRows(s.orgId);
    const bad = await download(s, "spec", { asOf: "2026-03-05T12:00" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("as_of must be a date (YYYY-MM-DD");
    expect(await usageKinds(s.orgId)).toEqual(usageBefore);
    expect(await auditRows(s.orgId)).toEqual(auditBefore);
    expect(auditBefore.filter((r) => r.action === "export.spec").some((r) => (r.metadata as { as_of?: boolean }).as_of === true)).toBe(true);
  }, 60_000);

  it("record.md: the verification block and every event hash; usage + audit export.record_md", async () => {
    const s = await scenario;
    const res = await download(s, "record_md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${s.shortCode}-record-2026-03-20.md"`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();

    const events = await withTenant(app.db, { orgId: s.orgId }, (tx) => readEvents(tx, s.engagementId));
    expect(events.length).toBeGreaterThan(10);
    expect(body).toContain("## Hash-chain verification");
    expect(body).toContain("**Hash-chain verification: OK**");
    expect(body).toContain("chain_verified: true");
    expect(body).toContain(`- **Head seq:** ${events.at(-1)!.seq}`);
    for (const e of events) expect(body).toContain(e.hash);

    expect(await usageKinds(s.orgId)).toContain("record_export_md");
    const audit = (await auditRows(s.orgId)).filter((r) => r.action === "export.record_md");
    expect(audit.at(-1)).toMatchObject({
      actorUserId: s.userId,
      targetId: s.engagementId,
      metadata: { chain_ok: true, head_seq: events.at(-1)!.seq, event_count: events.length },
    });
  }, 60_000);

  it("record.pdf: a PDF document; usage + audit export.record_pdf; the short code works as the route id", async () => {
    const s = await scenario;
    const res = await download(s, "record_pdf", { engagementRef: s.shortCode });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${s.shortCode}-record-2026-03-20.pdf"`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bytes.subarray(-6).toString("latin1")).toContain("%%EOF");

    expect(await usageKinds(s.orgId)).toContain("record_export_pdf");
    expect((await auditRows(s.orgId)).filter((r) => r.action === "export.record_pdf").at(-1)).toMatchObject({ actorUserId: s.userId, metadata: { chain_ok: true } });
  }, 60_000);
});
