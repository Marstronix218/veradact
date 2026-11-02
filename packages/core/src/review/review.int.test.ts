// Review queue (ARCHITECTURE §9.4): accept (with edits, revisions, dependency resolution), reject,
// re-runs and tenant isolation.
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { MockModelClient, type RawCandidate } from "@veradact/ai";
import { candidate } from "@veradact/db";
import { adminTestDb, testDb } from "@veradact/db/testing";
import { createItem } from "../commands";
import { ReviewError } from "../errors";
import { runExtraction } from "../extraction";
import { getItemDetail } from "../queries";
import { createLedgerEngagement, inTenant, NOTES_TEXT, type LedgerEngagement } from "../test-support/ledger";
import { acceptCandidate, rejectCandidate } from "./commands";
import { listCandidates, listExtractionRuns, type CandidateView } from "./queries";

const app = testDb();
const admin = adminTestDb();

afterAll(async () => {
  await Promise.all([app.close(), admin.close()]);
});

function raw(kind: string, quote: string, overrides: Partial<RawCandidate> = {}): RawCandidate {
  const start = NOTES_TEXT.indexOf(quote);
  return {
    kind,
    statement: `Statement for: ${quote}`,
    quote,
    start,
    end: start + quote.length,
    speaker_label: "Dana",
    confidence: 0.7,
    suggested_depends_on: [],
    revises: null,
    ...overrides,
  };
}

const Q = {
  csv: "We assume carriers accept CSV uploads.",
  dashboard: "The dispatch dashboard must refresh every five minutes.",
  sso: "Use the existing SSO provider for staff logins.",
  invoices: "Invoices are exported nightly to the carrier portal.",
  approval: "Route changes need approval within 48h.",
};

async function extract(e: LedgerEngagement, candidates: RawCandidate[]) {
  return runExtraction({ ...e, db: app.db, clock: e.ctx.clock, modelClientFactory: () => new MockModelClient([candidates]) });
}

async function pending(e: LedgerEngagement): Promise<CandidateView[]> {
  const groups = await inTenant(app, e.orgId, (tx) => listCandidates(tx, e.engagementId));
  return groups.flatMap((g) => g.candidates);
}

async function reviewCode(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(error instanceof ReviewError)) throw new Error(`expected a ReviewError, got ${String(error)}`);
  return error.code;
}

describe("review queue", () => {
  it("stores verified candidates, drops unverifiable ones and resolves #n suggestions on accept", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const result = await extract(e, [
      raw("assumption", Q.csv),
      raw("requirement", Q.dashboard, { suggested_depends_on: ["#1", "#9", "not a ref"] }),
      raw("decision", Q.sso, { suggested_depends_on: ["#2"] }),
      raw("constraint", Q.invoices, { start: 0, end: Q.invoices.length }),
      raw("requirement", "A quote that is not in the notes at all."),
    ]);
    expect(result).toMatchObject({ status: "succeeded", proposed: 5, stored: 4, dropped: 1, corrected: 1 });

    const [group] = await inTenant(app, e.orgId, (tx) => listCandidates(tx, e.engagementId));
    expect(group).toMatchObject({ sourceId: e.sourceId, title: "Kickoff notes", sourceType: "human_notes", redacted: false });
    const [csv, dashboard, sso, invoices] = group!.candidates;
    expect(group!.candidates.map((c) => c.ordinal)).toEqual([1, 2, 3, 4]);
    expect(invoices).toMatchObject({ verification: "offset_corrected", start: NOTES_TEXT.indexOf(Q.invoices) });
    expect(dashboard!.suggestedDependencies.map((d) => [d.ref, d.target?.type ?? null])).toEqual([
      ["#1", "candidate"],
      ["#9", null],
    ]);

    const a = await acceptCandidate(e.ctx, { candidateId: csv!.id, engagementId: e.engagementId });
    expect(a).toMatchObject({ shortId: "HALV-A1", version: 1, revised: false, edited: false, notes: [] });
    const d = await acceptCandidate(e.ctx, { candidateId: dashboard!.id });
    expect(d).toMatchObject({ shortId: "HALV-R1", dependsOn: [a.itemId], notes: [{ code: "dependency_unresolved", ref: "#9" }] });

    // Edit & accept: statement changed → provenance.edited; #2 resolves to the requirement.
    const s = await acceptCandidate(e.ctx, { candidateId: sso!.id, edits: { statement: "  Staff sign in through the existing SSO provider.  " } });
    expect(s).toMatchObject({ shortId: "HALV-D1", edited: true, dependsOn: [d.itemId] });

    await inTenant(app, e.orgId, async (tx) => {
      const detail = (await getItemDetail(tx, e.engagementId, s.itemId))!;
      expect(detail.versions[0]!.statement).toBe("Staff sign in through the existing SSO provider.");
      expect(detail.versions[0]!.provenance).toEqual({ via: "ai_candidate", candidate_id: sso!.id, model: "mock", prompt_version: "extract.v1", edited: true });
      expect(detail.versions[0]!.candidate).toMatchObject({ candidateId: sso!.id, verification: "exact", edited: true });
      expect(detail.versions[0]!.spans[0]).toMatchObject({ quote: Q.sso, quoteState: "verified" });
      expect(detail.dependencies.map((x) => x.shortId)).toEqual(["HALV-R1"]);
      const rows = await tx.select().from(candidate).where(eq(candidate.id, sso!.id));
      expect(rows[0]).toMatchObject({ status: "accepted", decidedBy: e.userId, resultingItemId: s.itemId });
    });

    // Accepted candidates leave the pending queue; the offset-corrected one cites the true offsets.
    expect((await pending(e)).map((c) => c.id)).toEqual([invoices!.id]);
    const inv = await acceptCandidate(e.ctx, { candidateId: invoices!.id, edits: { kind: "assumption" } });
    expect(inv).toMatchObject({ shortId: "HALV-A2", edited: true });
  });

  it("edited dependencies replace the suggestions; non-dependent kinds drop them with a note", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const manual = await createItem(e.ctx, { engagementId: e.engagementId, kind: "constraint", statement: "Carrier portal only accepts CSV.", manual: true });
    await extract(e, [raw("assumption", Q.csv, { suggested_depends_on: ["HALV-C1"] }), raw("requirement", Q.dashboard)]);
    const [csv, dashboard] = await pending(e);

    const a = await acceptCandidate(e.ctx, { candidateId: csv!.id });
    expect(a).toMatchObject({ edited: false, dependsOn: [], notes: [{ code: "dependency_kind_not_allowed", ref: "HALV-C1" }] });

    const r = await acceptCandidate(e.ctx, { candidateId: dashboard!.id, edits: { dependsOn: ["HALV-C1", manual.itemId, "HALV-X1"] } });
    expect(r).toMatchObject({ edited: true, dependsOn: [manual.itemId], notes: [{ code: "dependency_unresolved", ref: "HALV-X1" }] });
  });

  it("a revision candidate produces a new version whose only span is the candidate's quote", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const original = await createItem(e.ctx, {
      engagementId: e.engagementId,
      kind: "requirement",
      statement: "Route changes need approval within two business days.",
      spans: [{ sourceId: e.sourceId, quote: Q.approval }],
    });
    const result = await extract(e, [
      raw("requirement", Q.dashboard, { revises: original.shortId, statement: "Route changes and dashboard refresh rules are revised." }),
      raw("decision", Q.sso, { revises: original.shortId }),
      raw("requirement", Q.invoices, { revises: "HALV-R99" }),
    ]);
    expect(result.notes).toEqual([
      { ordinal: 2, code: "revises_kind_mismatch" },
      { ordinal: 3, code: "revises_not_found" },
    ]);
    const [rev, decision, unknown] = await pending(e);
    expect(rev!.revises).toMatchObject({ itemId: original.itemId, shortId: original.shortId, statement: "Route changes need approval within two business days." });
    expect(decision!.revises).toBeNull();
    expect(unknown!.revises).toBeNull();

    expect(await reviewCode(acceptCandidate(e.ctx, { candidateId: rev!.id, edits: { kind: "constraint" } }))).toBe("revision_kind_immutable");
    const accepted = await acceptCandidate(e.ctx, { candidateId: rev!.id });
    expect(accepted).toMatchObject({ itemId: original.itemId, shortId: original.shortId, version: 2, revised: true, edited: false });

    await inTenant(app, e.orgId, async (tx) => {
      const detail = (await getItemDetail(tx, e.engagementId, original.itemId))!;
      expect(detail.currentVersion).toBe(2);
      const v2 = detail.versions[1]!;
      expect(v2).toMatchObject({ statement: "Route changes and dashboard refresh rules are revised.", reasonCode: "new_information" });
      expect(v2.provenance).toMatchObject({ via: "ai_candidate", candidate_id: rev!.id });
      expect(v2.spans.map((s) => ({ quote: s.quote, carried: s.carried }))).toEqual([{ quote: Q.dashboard, carried: false }]);
      expect(detail.versions[0]!.spans[0]!.quote).toBe(Q.approval);
    });

    // Accepting the unknown-revision candidate creates a new item instead.
    const created = await acceptCandidate(e.ctx, { candidateId: unknown!.id });
    expect(created).toMatchObject({ revised: false, version: 1, shortId: "HALV-R2" });
  });

  it("rejects candidates; decided candidates cannot be decided again; a re-run replaces pending ones", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    await extract(e, [raw("assumption", Q.csv), raw("requirement", Q.dashboard), raw("decision", Q.sso)]);
    const [csv, dashboard, sso] = await pending(e);

    await rejectCandidate(e.ctx, { candidateId: csv!.id, engagementId: e.engagementId });
    await acceptCandidate(e.ctx, { candidateId: dashboard!.id });
    expect(await reviewCode(acceptCandidate(e.ctx, { candidateId: csv!.id }))).toBe("candidate_decided");
    expect(await reviewCode(rejectCandidate(e.ctx, { candidateId: dashboard!.id }))).toBe("candidate_decided");
    expect(await reviewCode(rejectCandidate(e.ctx, { candidateId: "not-a-uuid" }))).toBe("candidate_not_found");
    expect(await reviewCode(acceptCandidate(e.ctx, { candidateId: sso!.id, engagementId: e.ctx.orgId }))).toBe("candidate_not_found");

    const rejected = await inTenant(app, e.orgId, (tx) => listCandidates(tx, e.engagementId, { status: "rejected" }));
    expect(rejected.flatMap((g) => g.candidates.map((c) => c.id))).toEqual([csv!.id]);

    const rerun = await extract(e, [raw("constraint", Q.invoices)]);
    expect(rerun.stored).toBe(1);
    const left = await pending(e);
    expect(left.map((c) => c.statement)).toEqual([`Statement for: ${Q.invoices}`]);
    const runs = await inTenant(app, e.orgId, (tx) => listExtractionRuns(tx, e.engagementId, { sourceId: e.sourceId }));
    expect(runs.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);
    expect(runs[0]!.id).toBe(rerun.runId);
    // Decided rows from the first run stay.
    const all = await inTenant(app, e.orgId, (tx) => tx.select().from(candidate).where(eq(candidate.engagementId, e.engagementId)));
    expect(all.map((c) => c.status).sort()).toEqual(["accepted", "pending", "rejected"]);
  });

  it("another tenant cannot see, accept or reject a candidate", async () => {
    const e = await createLedgerEngagement(app, admin.db);
    const other = await createLedgerEngagement(app, admin.db);
    await extract(e, [raw("assumption", Q.csv)]);
    const [c] = await pending(e);

    expect(await reviewCode(acceptCandidate(other.ctx, { candidateId: c!.id }))).toBe("candidate_not_found");
    expect(await reviewCode(rejectCandidate(other.ctx, { candidateId: c!.id }))).toBe("candidate_not_found");
    expect(await inTenant(app, other.orgId, (tx) => listCandidates(tx, e.engagementId))).toEqual([]);
    expect(await inTenant(app, other.orgId, (tx) => listExtractionRuns(tx, e.engagementId))).toEqual([]);
    // Still pending for its own tenant.
    expect((await pending(e)).map((x) => x.id)).toEqual([c!.id]);
  });
});
