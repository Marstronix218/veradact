/**
 * The engagement record as PDF (pdfkit, built-in Helvetica only, no external assets). Same content
 * as `renderRecordMarkdown`; every page carries a header (engagement) and a footer (generated at,
 * "Page n of m"). Deterministic for identical input: the PDF dates come from `ctx.generatedAt`.
 */
import PDFDocument from "pdfkit";
import type { ExportContext } from "./context";
import { formatDate, formatDateTime, isoUtc, KIND_SECTION } from "./format";
import { contactLabel, groupByKind, notConfirmedStatus, presentItem, type ItemPresentation } from "./present";
import {
  APPENDIX_CODE,
  APPENDIX_INTRO,
  APPENDIX_STEPS,
  CONTENT_HASH_LABEL,
  EVIDENCE_LABEL,
  EVIDENCE_LEGEND,
  RESPONSE_LABEL,
  verificationSummary,
  type RecordExport,
} from "./record";

export interface RecordPdfOptions {
  /** Compress page content streams (default true). Tests pass false to search the text. */
  compress?: boolean;
}

const PAGE_WIDTH = 612; // US Letter
const PAGE_HEIGHT = 792;
const MARGIN = { top: 66, bottom: 62, left: 54, right: 54 };
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN.left - MARGIN.right;
const BOTTOM = PAGE_HEIGHT - MARGIN.bottom;
const LABEL_WIDTH = 112;

const FONT = { regular: "Helvetica", bold: "Helvetica-Bold", italic: "Helvetica-Oblique" } as const;
const COLOR = { text: "#111111", muted: "#555555", rule: "#bbbbbb", zebra: "#f2f2f2", ok: "#1b5e20", fail: "#b00020", warn: "#8a4b00" } as const;

// Characters the standard fonts can draw (WinAnsiEncoding) besides printable ASCII and Latin-1.
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

/** Text the built-in fonts can render: unsupported characters become "?" (the markdown export is exact). */
export function pdfText(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFC")) {
    const code = ch.codePointAt(0)!;
    if (ch === "\n") out += "\n";
    else if (ch === "\t" || ch === "\r") out += " ";
    else if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(ch)) out += ch;
    else if (code < 0x20 || (code >= 0x7f && code < 0xa0)) continue;
    else out += "?";
  }
  return out;
}

function stripCode(text: string): string {
  return text.replace(/`/g, "");
}

interface Column {
  header: string;
  width: number;
  align?: "left" | "right";
}

interface Row {
  cells: string[];
  /** Full-width second line in a smaller font. */
  detail?: string;
  color?: string;
}

class PdfWriter {
  constructor(readonly doc: PDFKit.PDFDocument) {}

  private style(font: string, size: number, color: string = COLOR.text): PDFKit.PDFDocument {
    return this.doc.font(font).fontSize(size).fillColor(color);
  }

  /** Starts a new page unless `height` points fit above the bottom margin. */
  ensure(height: number): void {
    if (this.doc.y + height > BOTTOM) this.doc.addPage();
  }

  space(points: number): void {
    if (this.doc.y + points <= BOTTOM) this.doc.y += points;
  }

  text(s: string, opts: { font?: string; size?: number; color?: string; indent?: number; gap?: number } = {}): void {
    const { font = FONT.regular, size = 9, color = COLOR.text, indent = 0, gap = 3 } = opts;
    this.style(font, size, color).text(pdfText(s), MARGIN.left + indent, this.doc.y, { width: CONTENT_WIDTH - indent });
    this.space(gap);
  }

  heading(s: string, level: 1 | 2 | 3): void {
    const size = level === 1 ? 17 : level === 2 ? 13 : 11;
    this.ensure(size * 2 + 36);
    if (level > 1 && this.doc.y > MARGIN.top) this.space(size * 0.7);
    this.text(s, { font: FONT.bold, size, gap: size * 0.4 });
  }

  /** Label in a left column, value wrapping in the right column. */
  field(label: string, value: string, opts: { font?: string; color?: string; size?: number; indent?: number } = {}): void {
    const { font = FONT.regular, color = COLOR.text, size = 9, indent = 0 } = opts;
    const valueWidth = CONTENT_WIDTH - indent - LABEL_WIDTH;
    const safeValue = pdfText(value);
    this.style(font, size);
    this.ensure(Math.min(this.doc.heightOfString(safeValue, { width: valueWidth }), 80));
    const page = this.doc.page;
    const y = this.doc.y;
    this.style(FONT.bold, size, COLOR.muted).text(pdfText(label), MARGIN.left + indent, y, { width: LABEL_WIDTH - 8 });
    const labelBottom = this.doc.y;
    this.style(font, size, color).text(safeValue, MARGIN.left + indent + LABEL_WIDTH, y, { width: valueWidth });
    if (this.doc.page === page) this.doc.y = Math.max(this.doc.y, labelBottom);
    this.space(2);
  }

  table(columns: Column[], rows: Row[], size = 7.2): void {
    const pad = 2.5;
    const doc = this.doc;
    const drawHeader = () => {
      this.style(FONT.bold, size, COLOR.muted);
      const height = Math.max(...columns.map((c) => doc.heightOfString(pdfText(c.header), { width: c.width - 2 * pad }))) + 2 * pad;
      const y = doc.y;
      let x = MARGIN.left;
      for (const c of columns) {
        doc.text(pdfText(c.header), x + pad, y + pad, { width: c.width - 2 * pad, align: c.align ?? "left" });
        x += c.width;
      }
      doc.moveTo(MARGIN.left, y + height).lineTo(MARGIN.left + CONTENT_WIDTH, y + height).lineWidth(0.6).strokeColor(COLOR.rule).stroke();
      doc.y = y + height;
    };
    this.ensure(size * 8);
    drawHeader();
    rows.forEach((row, index) => {
      this.style(FONT.regular, size);
      const cells = row.cells.map(pdfText);
      const cellHeight = Math.max(...columns.map((c, i) => doc.heightOfString(cells[i] ?? "", { width: c.width - 2 * pad })));
      const detail = row.detail ? pdfText(row.detail) : null;
      doc.fontSize(size - 0.6);
      const detailHeight = detail ? doc.heightOfString(detail, { width: CONTENT_WIDTH - 2 * pad }) + 1 : 0;
      const height = cellHeight + detailHeight + 2 * pad;
      if (doc.y + height > BOTTOM - 1) {
        doc.addPage();
        drawHeader();
      }
      const y = doc.y;
      if (index % 2 === 1) doc.rect(MARGIN.left, y, CONTENT_WIDTH, height).fill(COLOR.zebra);
      this.style(FONT.regular, size, row.color ?? COLOR.text);
      let x = MARGIN.left;
      columns.forEach((c, i) => {
        doc.text(cells[i] ?? "", x + pad, y + pad, { width: c.width - 2 * pad, align: c.align ?? "left" });
        x += c.width;
      });
      if (detail) {
        this.style(FONT.regular, size - 0.6, COLOR.muted).text(detail, MARGIN.left + pad, y + pad + cellHeight + 1, { width: CONTENT_WIDTH - 2 * pad });
      }
      doc.y = y + height;
    });
    this.space(6);
  }
}

function writeItem(w: PdfWriter, p: ItemPresentation): void {
  w.ensure(70);
  w.text(`${p.shortId} · ${p.statement}`, { font: FONT.bold, size: 10.5, gap: 2 });
  for (const warning of p.reviewWarnings) {
    w.text(`Needs review: ${warning}. Check with the team before building on this item.`, { font: FONT.bold, color: COLOR.warn, gap: 2 });
  }
  w.field("Version", String(p.version));
  w.field("Content hash", p.contentHash);
  if (p.manual) w.field("Source", p.manual);
  for (const c of p.citations) {
    w.field("Source", `${c.label}, ${c.offsets}${c.note ? ` — ${c.note}` : ""}`);
    if (c.quote !== null) w.text(`“${c.quote.trim()}”`, { font: FONT.italic, indent: LABEL_WIDTH, color: COLOR.muted });
  }
  w.field("Confirmed by", p.confirmedBy.length > 0 ? p.confirmedBy.join(", ") : "none recorded");
  if (p.dependsOn.length > 0) w.field("Depends on", p.dependsOn.join(", "));
  w.space(8);
}

function writeHeadersAndFooters(doc: PDFKit.PDFDocument, ctx: ExportContext): void {
  const e = ctx.engagement;
  const left = pdfText(`Engagement record · ${e.name} (${e.shortCode}) · ${e.clientName}`).slice(0, 110);
  const generated = pdfText(`Generated ${formatDateTime(ctx.generatedAt, e.timeZone)} · ${ctx.vendorName}`).slice(0, 110);
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const margins = doc.page.margins;
    // Draw inside the margins without triggering an automatic page break.
    doc.page.margins = { ...margins, top: 0, bottom: 0 };
    doc.font(FONT.regular).fontSize(7.5).fillColor(COLOR.muted);
    doc.text(left, MARGIN.left, 34, { lineBreak: false });
    doc.moveTo(MARGIN.left, 46).lineTo(MARGIN.left + CONTENT_WIDTH, 46).lineWidth(0.5).strokeColor(COLOR.rule).stroke();
    const footerY = PAGE_HEIGHT - 42;
    doc.moveTo(MARGIN.left, footerY - 6).lineTo(MARGIN.left + CONTENT_WIDTH, footerY - 6).lineWidth(0.5).strokeColor(COLOR.rule).stroke();
    doc.font(FONT.regular).fontSize(7.5).fillColor(COLOR.muted);
    doc.text(generated, MARGIN.left, footerY, { lineBreak: false });
    const pageLabel = `Page ${i - range.start + 1} of ${range.count}`;
    doc.text(pageLabel, MARGIN.left + CONTENT_WIDTH - doc.widthOfString(pageLabel), footerY, { lineBreak: false });
    doc.page.margins = margins;
  }
}

function writeRecord(doc: PDFKit.PDFDocument, record: RecordExport, ctx: ExportContext): void {
  const w = new PdfWriter(doc);
  const e = ctx.engagement;
  const tz = e.timeZone;
  const view = record.agreed;

  w.heading(`Engagement record: ${e.name}`, 1);
  w.field("Engagement", `${e.name} (${e.shortCode})`);
  w.field("Client", e.clientName);
  w.field("Vendor", ctx.vendorName);
  w.field("Generated", `${formatDateTime(ctx.generatedAt, tz)} (${isoUtc(ctx.generatedAt)})`);
  w.field("Time zone", tz);
  w.field("Agreed record as of", `${formatDateTime(view.asOf, tz)} (${isoUtc(view.asOf)}), log through seq ${view.head.seq}`);
  w.field("Log head at export", `seq ${ctx.head.seq}`);
  w.field("Log head hash", ctx.head.hash);
  w.field("Events in record", String(record.events.length));
  w.space(4);
  w.text("This record is generated from the engagement's append-only, hash-chained event log. Times in tables are UTC, exactly as recorded and hashed.", {
    color: COLOR.muted,
  });

  // Hash-chain verification, boxed with a colored bar.
  const summary = verificationSummary(record);
  const accent = summary.ok ? COLOR.ok : COLOR.fail;
  w.heading("Hash-chain verification", 2);
  w.ensure(150);
  const boxPage = doc.page;
  const boxTop = doc.y;
  doc.y += 6;
  w.text(summary.headline, { font: FONT.bold, size: 14, color: accent, indent: 10, gap: 4 });
  for (const [label, value] of summary.facts) {
    const failed = (label === "Result" && !summary.ok) || (label === CONTENT_HASH_LABEL && record.contentHashes.mismatches.length > 0);
    w.field(label, value, { font: failed ? FONT.bold : FONT.regular, color: failed ? COLOR.fail : COLOR.text, indent: 10 });
  }
  w.space(4);
  for (const p of summary.paragraphs) w.text(p, { size: 8.5, indent: 10, gap: 4 });
  if (doc.page === boxPage) {
    const boxBottom = doc.y + 2;
    doc.rect(MARGIN.left, boxTop, CONTENT_WIDTH, boxBottom - boxTop).lineWidth(0.8).strokeColor(accent).stroke();
    doc.rect(MARGIN.left, boxTop, 4, boxBottom - boxTop).fill(accent);
    doc.y = boxBottom;
  }
  w.space(8);

  // Agreed record.
  w.heading("Agreed record", 2);
  w.text(`Items whose current version was confirmed as of ${formatDateTime(view.asOf, tz)}, shown at the confirmed version.`, { color: COLOR.muted });
  if (!e.aiEnabled) {
    w.text("AI is off for this engagement. Source quotes are omitted; each source is cited by type, date and character offsets into its normalized text.", {
      font: FONT.bold,
      color: COLOR.warn,
    });
  }
  for (const [kind, items] of groupByKind(view.items)) {
    w.heading(KIND_SECTION[kind], 3);
    if (items.length === 0) w.text("None confirmed.", { color: COLOR.muted });
    for (const item of items) writeItem(w, presentItem(item, ctx));
  }
  w.heading("Not confirmed", 3);
  if (view.notConfirmed.length === 0) w.text("None.", { color: COLOR.muted });
  for (const i of view.notConfirmed) w.text(`• ${i.shortId} · ${i.statement} (${notConfirmedStatus(i)})`, { indent: 6 });
  if (view.previouslyAgreed.length > 0) {
    w.heading("Previously agreed versions (revision pending)", 3);
    for (const p of view.previouslyAgreed) {
      const by = p.confirmations.map((c) => `${contactLabel(c.contactId, c.contactErased, ctx)} (${formatDate(c.recordedAt, tz)})`).join(", ");
      w.text(
        `• ${p.shortId} · ${p.agreedStatement} — agreed at version ${p.agreedVersion} (${p.agreedContentHash}) by ${by || "none recorded"}; current version ${p.currentVersion} is ${p.currentStatus}.`,
        { indent: 6 },
      );
    }
  }

  // Confirmations and disputes.
  w.heading("Confirmations and disputes", 2);
  if (record.responses.length === 0) w.text("No responses recorded.", { color: COLOR.muted });
  else {
    w.table(
      [
        { header: "Seq", width: 30, align: "right" },
        { header: "Recorded at (UTC)", width: 108 },
        { header: "Contact", width: 140 },
        { header: "Response", width: 56 },
        { header: "Item", width: 70 },
        { header: "Version", width: 34, align: "right" },
        { header: "Evidence", width: 66 },
      ],
      record.responses.map((r) => ({
        cells: [
          String(r.seq),
          isoUtc(r.recordedAt),
          contactLabel(r.contactId, r.evidence === "erased", ctx),
          RESPONSE_LABEL[r.type],
          r.shortId,
          String(r.version),
          EVIDENCE_LABEL[r.evidence],
        ],
        detail: `Content hash ${r.contentHash} · Request ${r.requestId}`,
        color: r.evidence === "mismatch" ? COLOR.fail : undefined,
      })),
    );
    w.text(EVIDENCE_LEGEND, { size: 7.5, color: COLOR.muted });
    const comments = record.responses.filter((r) => r.type === "item_disputed" && r.comment !== undefined);
    if (comments.length > 0) {
      w.text("Dispute comments", { font: FONT.bold, size: 9.5 });
      for (const r of comments) {
        w.text(`Seq ${r.seq} · ${r.shortId} version ${r.version} · ${contactLabel(r.contactId, r.evidence === "erased", ctx)}:`, { gap: 1 });
        w.text(r.comment ? `“${r.comment.trim()}”` : "(comment erased)", { font: FONT.italic, indent: 12, color: COLOR.muted });
      }
    }
  }

  // Authorizations.
  w.heading("Authorizations", 2);
  if (record.authorizations.length === 0) w.text("No authorizations recorded.", { color: COLOR.muted });
  else {
    w.table(
      [
        { header: "Seq", width: 30, align: "right" },
        { header: "Recorded at (UTC)", width: 108 },
        { header: "Contact", width: 150 },
        { header: "Decision", width: 60 },
        { header: "Text version", width: 90 },
        { header: "Evidence", width: 66 },
      ],
      record.authorizations.map((a) => ({
        cells: [String(a.seq), isoUtc(a.recordedAt), contactLabel(a.contactId, a.evidence === "erased", ctx), a.decision, a.textVersion, EVIDENCE_LABEL[a.evidence]],
        color: a.evidence === "mismatch" ? COLOR.fail : undefined,
      })),
    );
    w.text(EVIDENCE_LEGEND, { size: 7.5, color: COLOR.muted });
  }

  // Event log.
  const badSeq = record.verification.ok ? undefined : record.verification.firstBadSeq;
  w.heading("Event log", 2);
  w.text(`${record.events.length} events. Each hash covers the event's content and the previous event's hash (prev_hash; 64 zeros for seq 1).`, {
    color: COLOR.muted,
  });
  w.table(
    [
      { header: "Seq", width: 34, align: "right" },
      { header: "Type", width: 110 },
      { header: "Recorded at (UTC)", width: 110 },
      { header: "Hash", width: 250 },
    ],
    record.events.map((ev) => ({
      cells: [ev.seq === badSeq ? `${ev.seq} !` : String(ev.seq), ev.type, isoUtc(ev.recordedAt), ev.hash],
      color: ev.seq === badSeq ? COLOR.fail : undefined,
    })),
    7,
  );
  if (badSeq !== undefined) w.text(`! marks seq ${badSeq}, where verification failed.`, { size: 7.5, color: COLOR.fail });

  // Appendix.
  w.heading("Appendix: recomputing the hashes", 2);
  w.text(stripCode(APPENDIX_INTRO));
  APPENDIX_STEPS.forEach((s, i) => w.text(`${i + 1}. ${stripCode(s)}`, { indent: 8 }));
  w.text("In Node.js:", { gap: 2 });
  w.text(APPENDIX_CODE.join("\n"), { size: 7.5, indent: 8, color: COLOR.muted });
}

/** Renders the record as a PDF. Long logs paginate; every page has a header and "Page n of m". */
export function renderRecordPdf(record: RecordExport, ctx: ExportContext, options: RecordPdfOptions = {}): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margins: MARGIN,
      bufferPages: true,
      compress: options.compress ?? true,
      displayTitle: true,
      info: {
        Title: `Engagement record: ${ctx.engagement.name} (${ctx.engagement.shortCode})`,
        Author: ctx.vendorName,
        Subject: `Log head seq ${ctx.head.seq} ${ctx.head.hash}`,
        Creator: "Veradact",
        Producer: "Veradact (PDFKit)",
        CreationDate: ctx.generatedAt,
        ModDate: ctx.generatedAt,
      },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      writeRecord(doc, record, ctx);
      writeHeadersAndFooters(doc, ctx);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}
