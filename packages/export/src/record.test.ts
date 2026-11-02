import { computeEventHash, verifyChain, type StoredEvent } from "@veradact/core";
import { describe, expect, it } from "vitest";
import { buildRecordExport, recordFilename, renderRecordMarkdown, type EvidenceStatus } from "./record";
import { contextFor, halvLog, NAMES, QUOTES, STATEMENTS } from "./test-fixtures";

function halvRecord(events?: StoredEvent[]) {
  const b = halvLog();
  const log = events ?? b.log;
  const bob = b.id("contact:bob");
  const head = { seq: b.last.seq, hash: b.last.hash };
  const record = buildRecordExport(log, {
    evidenceFor: (_seq, contactId): EvidenceStatus => (contactId === bob ? "erased" : "verified"),
    commentFor: () => "Portal access was promised | <b>in March</b>",
    expectedHead: head,
  });
  return { b, log, head, record, ctx: contextFor(b, log) };
}

/**
 * A forged log: one item statement changed, then every hash from there recomputed, so the chain
 * verifies but the stored content hash no longer matches the content.
 */
function rechainedLog(log: StoredEvent[], seq: number): StoredEvent[] {
  let prevHash = "";
  return log.map((e) => {
    let next: StoredEvent = e.seq === seq && e.type === "item_created" ? ({ ...e, payload: { ...e.payload, statement: "Changed after the fact" } } as StoredEvent) : e;
    if (e.seq >= seq) {
      next = { ...next, prevHash } as StoredEvent;
      next = { ...next, hash: computeEventHash(next) } as StoredEvent;
    }
    prevHash = next.hash;
    return next;
  });
}

/** A copy of the log with one item statement changed in place (what a DB edit would do). */
function tamperedLog(log: StoredEvent[], seq: number): StoredEvent[] {
  return log.map((e) => (e.seq === seq && e.type === "item_created" ? ({ ...e, payload: { ...e.payload, statement: "Changed after the fact" } } as StoredEvent) : e));
}

describe("buildRecordExport", () => {
  it("collects responses, authorizations, events and the chain verification from the log", () => {
    const { b, record } = halvRecord();
    expect(record.events).toHaveLength(b.log.length);
    expect(record.verification).toEqual(verifyChain(b.log, { seq: b.last.seq, hash: b.last.hash }));
    expect(record.verification.ok).toBe(true);
    expect(record.responses.map((r) => [r.shortId, r.type, r.evidence])).toEqual([
      ["HALV-P1", "item_confirmed", "verified"],
      ["HALV-C1", "item_confirmed", "verified"],
      ["HALV-A1", "item_confirmed", "verified"],
      ["HALV-D1", "item_confirmed", "verified"],
      ["HALV-R1", "item_confirmed", "verified"],
      ["HALV-C2", "item_confirmed", "erased"],
      ["HALV-R3", "item_disputed", "erased"],
    ]);
    expect(record.responses.filter((r) => r.comment !== undefined).map((r) => r.shortId)).toEqual(["HALV-R3"]);
    expect(record.authorizations.map((a) => a.decision)).toEqual(["granted", "granted"]);
    const bob = b.id("contact:bob");
    expect(record.authorizations.map((a) => [a.contactId === bob ? "bob" : "alice", a.evidence])).toEqual([
      ["alice", "verified"],
      ["bob", "erased"],
    ]);
    expect(record.agreed.items.map((i) => i.shortId)).toEqual(["HALV-P1", "HALV-C1", "HALV-C2", "HALV-A1", "HALV-R1"]);
    const versions = b.log.filter((e) => e.type === "item_created" || e.type === "item_revised").length;
    expect(versions).toBeGreaterThan(5);
    expect(record.contentHashes).toEqual({ checked: versions, mismatches: [] });
  });

  it("recomputes every item content hash and reports a mismatch even when the chain verifies", () => {
    const b = halvLog();
    const target = b.log.find((e) => e.type === "item_created")!;
    const forged = rechainedLog(b.log, target.seq);
    const last = forged.at(-1)!;
    const record = buildRecordExport(forged, { evidenceFor: () => "verified", expectedHead: { seq: last.seq, hash: last.hash } });
    expect(record.verification.ok).toBe(true);
    const shortId = (target.payload as { short_id: string }).short_id;
    expect(record.contentHashes.mismatches).toEqual([{ seq: target.seq, shortId, version: 1 }]);

    const md = renderRecordMarkdown(record, contextFor(b, forged));
    const n = record.contentHashes.checked;
    expect(md).toContain("**Hash-chain verification: OK**");
    expect(md).toContain("chain_verified: true");
    expect(md).toContain("content_hashes_verified: false");
    expect(md).toContain(`- **Item content hashes:** ${n - 1} of ${n} verified; 1 MISMATCH (${shortId} v1 at seq ${target.seq})`);
  });
});

describe("renderRecordMarkdown", () => {
  it("includes every event hash and an OK verification block", () => {
    const { record, ctx, head } = halvRecord();
    const md = renderRecordMarkdown(record, ctx);
    for (const e of record.events) expect(md).toContain(`| ${e.seq} | \`${e.type}\` | ${e.recordedAt.toISOString()} | ${e.occurredAt.toISOString()} | \`${e.hash}\` |`);
    expect(md).toContain("## Hash-chain verification\n\n**Hash-chain verification: OK**");
    expect(md).toContain(`- **Events checked:** ${record.events.length} of ${record.events.length} (all events)`);
    expect(md).toContain(`- **Head seq:** ${head.seq}`);
    expect(md).toContain(`- **Head hash:** \`${head.hash}\``);
    expect(md).toContain(`- **Expected head hash:** \`${head.hash}\``);
    expect(md).toContain("confirmation receipts emailed to the client");
    expect(md).toContain("chain_verified: true");
    expect(md).toContain("content_hashes_verified: true");
    expect(md).toContain(`- **Item content hashes:** ${record.contentHashes.checked} of ${record.contentHashes.checked} verified`);
    expect(md).not.toContain("First bad seq");
  });

  it("reports a FAILED chain with the reason and first bad seq when a payload was changed", () => {
    const b = halvLog();
    const target = b.log.find((e) => e.type === "item_created")!.seq;
    const { record, ctx } = halvRecord(tamperedLog(b.log, target));
    expect(record.verification).toMatchObject({ ok: false, reason: "hash_mismatch", firstBadSeq: target, checked: target - 1 });
    const md = renderRecordMarkdown(record, ctx);
    expect(md).toContain("**Hash-chain verification: FAILED**");
    expect(md).toContain("- **Result:** FAILED");
    expect(md).toContain(`- **Events checked:** ${target - 1} of ${record.events.length} verified before the failure`);
    expect(md).toContain("(hash\\_mismatch)");
    expect(md).toContain(`- **First bad seq:** ${target}`);
    expect(md).toContain(`verification FAILED at seq ${target}. Events 1–${target - 1} verified.`);
    expect(md).toContain(`| **${target} (first bad)** |`);
    expect(md).toContain("chain_verified: false");
    // Every stored hash is still listed.
    for (const e of record.events) expect(md).toContain(`\`${e.hash}\``);
  });

  it("reports a truncated log against a later expected head", () => {
    const b = halvLog();
    const head = { seq: b.last.seq, hash: b.last.hash };
    const short = b.log.slice(0, -2);
    const record = buildRecordExport(short, { evidenceFor: () => "verified", expectedHead: head });
    const md = renderRecordMarkdown(record, contextFor(b, short));
    expect(record.verification).toMatchObject({ ok: false, reason: "truncated", firstBadSeq: short.length + 1 });
    expect(md).toContain("**Hash-chain verification: FAILED**");
    expect(md).toContain("(truncated)");
  });

  it("lists confirmations and disputes with contact, version, content hash, request id and evidence", () => {
    const { b, record, ctx } = halvRecord();
    const md = renderRecordMarkdown(record, ctx);
    const requestId = b.id("request:q1");
    for (const r of record.responses) {
      const contact = r.evidence === "erased" ? "Erased contact" : NAMES.alice;
      const response = r.type === "item_confirmed" ? "confirmed" : "disputed";
      expect(md).toContain(
        `| ${r.seq} | ${r.recordedAt.toISOString()} | ${contact} | ${response} | ${r.shortId} | ${r.version} | \`${r.contentHash}\` | \`${requestId}\` | ${r.evidence} |`,
      );
    }
    expect(md).not.toContain(NAMES.bob);
    expect(md).toContain("  > Portal access was promised \\| \\<b\\>in March\\</b\\>");
    const [aliceAuth, bobAuth] = record.authorizations;
    expect(md).toContain(`| ${aliceAuth!.seq} | ${aliceAuth!.recordedAt.toISOString()} | ${NAMES.alice} | granted | v1 | verified |`);
    expect(md).toContain(`| ${bobAuth!.seq} | ${bobAuth!.recordedAt.toISOString()} | Erased contact | granted | v1 | erased |`);
    expect(md).toContain("## Appendix: recomputing the hashes");
    expect(md).toContain("canonical JSON");
  });

  it("includes the agreed record with the same per-item content and AI-off rules as the spec", () => {
    const { record, ctx } = halvRecord();
    const md = renderRecordMarkdown(record, ctx);
    expect(md).toContain(`#### HALV-P1 · ${STATEMENTS.p1}`);
    expect(md).toContain(`  > ${QUOTES.p1}`);
    expect(md).toContain("- **Needs review:** upstream HALV-D1 was revised.");
    expect(md).toContain(`- HALV-D1 · ${STATEMENTS.d1v2} (revision pending; previously agreed)`);
    expect(md).toContain(`- HALV-D1 · ${STATEMENTS.d1v1} — agreed at version 1`);

    const off = renderRecordMarkdown(record, { ...ctx, engagement: { ...ctx.engagement, aiEnabled: false } });
    for (const quote of Object.values(QUOTES)) {
      for (const line of quote.split("\n")) expect(off).not.toContain(line);
    }
    expect(off).toContain("**AI is off for this engagement.**");
  });

  it("is deterministic and names files by generation date in the engagement time zone", () => {
    const a = halvRecord();
    const b = halvRecord();
    expect(renderRecordMarkdown(a.record, a.ctx)).toBe(renderRecordMarkdown(b.record, b.ctx));
    expect(recordFilename(a.ctx, "md")).toBe("HALV-record-2026-11-01.md");
    expect(recordFilename({ ...a.ctx, generatedAt: new Date("2026-11-02T03:00:00.000Z") }, "pdf")).toBe("HALV-record-2026-11-01.pdf");
  });
});
