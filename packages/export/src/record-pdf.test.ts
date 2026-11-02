import { LogBuilder } from "@veradact/core/testing";
import { describe, expect, it } from "vitest";
import { buildRecordExport } from "./record";
import { pdfText, renderRecordPdf } from "./record-pdf";
import { contextFor, halvLog, pdfTextContent } from "./test-fixtures";

function halvRecord() {
  const b = halvLog();
  const record = buildRecordExport(b.log, { evidenceFor: () => "verified", expectedHead: { seq: b.last.seq, hash: b.last.hash } });
  return { b, record, ctx: contextFor(b) };
}

function pageCount(text: string): number {
  const m = /Page 1 of (\d+)/.exec(text);
  return m ? Number(m[1]) : 0;
}

describe("renderRecordPdf", () => {
  it("returns a PDF buffer", async () => {
    const { record, ctx } = halvRecord();
    const pdf = await renderRecordPdf(record, ctx);
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.subarray(-6).toString("latin1")).toContain("%%EOF");
  });

  it("draws the short ids, the head hash, the verification result and page footers", async () => {
    const { record, ctx } = halvRecord();
    const text = pdfTextContent(await renderRecordPdf(record, ctx, { compress: false }));
    expect(text).toContain("HALV-P1");
    expect(text).toContain("HALV-R1");
    expect(text).toContain(record.verification.headHash);
    expect(text).toContain(ctx.head.hash);
    expect(text).toContain("Hash-chain verification: OK");
    expect(text).toContain(`${record.contentHashes.checked} of ${record.contentHashes.checked} verified`);
    expect(record.authorizations.length).toBeGreaterThan(0);
    for (const e of record.events) expect(text).toContain(e.hash);
    const pages = pageCount(text);
    expect(pages).toBeGreaterThan(0);
    for (let n = 1; n <= pages; n++) expect(text).toContain(`Page ${n} of ${pages}`);
    expect(text).toContain("Engagement record");
    expect(text).toContain("Generated 2026-11-01 09:00 UTC-05:00");
  });

  it("is byte-for-byte deterministic for identical input", async () => {
    const a = halvRecord();
    const b = halvRecord();
    expect((await renderRecordPdf(a.record, a.ctx)).equals(await renderRecordPdf(b.record, b.ctx))).toBe(true);
  });

  it("paginates a 600-event log with headers and footers on every page", async () => {
    const b = new LogBuilder({ start: new Date("2026-03-02T15:00:00.000Z") }).engagement().source("kickoff");
    const names: string[] = [];
    for (let i = 0; i < 300; i++) {
      names.push(`r${i}`);
      b.create(`r${i}`, "requirement", `Requirement number ${i} for the nightly export`, { spans: [{ source: "kickoff", start: i % 20, end: (i % 20) + 10 }] });
    }
    b.tick().request("q1", names, ["alice"]).authorize("alice", "q1");
    for (let i = 0; i < 296; i++) b.tick(1000).confirm(`r${i}`, "alice", "q1", { submission: "s" });
    expect(b.log).toHaveLength(600);

    const record = buildRecordExport(b.log, { evidenceFor: () => "verified", expectedHead: { seq: b.last.seq, hash: b.last.hash } });
    expect(record.verification.ok).toBe(true);
    const text = pdfTextContent(await renderRecordPdf(record, contextFor(b), { compress: false }));
    const pages = pageCount(text);
    expect(pages).toBeGreaterThan(10);
    expect(text).toContain(`Page ${pages} of ${pages}`);
    expect(text.match(/Engagement record · Halvorsen rollout \(HALV\)/g)).toHaveLength(pages);
    expect(text).toContain(b.last.hash);
  });
});

describe("pdfText", () => {
  it("keeps what the standard fonts can draw and replaces the rest", () => {
    expect(pdfText("HALV-R1 · “Quote” — café €5…")).toBe("HALV-R1 · “Quote” — café €5…");
    expect(pdfText("東京 ok 🙂\u0007")).toBe("?? ok ?");
    expect(pdfText("a\tb\r\nc")).toBe("a b \nc");
  });
});
