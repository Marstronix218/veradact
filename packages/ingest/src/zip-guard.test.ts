import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseSource } from "./parse";
import { assertZipWithinLimits, MAX_DOCX_ENTRIES, MAX_DOCX_UNCOMPRESSED_BYTES } from "./zip-guard";

// Synthetic archives built in memory (no binary fixtures). CRCs are left 0: the guard does not
// check them, and mammoth/JSZip does not either by default.

interface Entry {
  name: string;
  data: Uint8Array;
  deflate?: boolean;
  /** Overrides the uncompressed size written to the headers (a lying archive). */
  declaredSize?: number;
}

function zip(entries: Entry[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = enc.encode(entry.name);
    const body = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const size = entry.declaredSize ?? entry.data.length;
    const method = entry.deflate ? 8 : 0;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, method, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, body);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(10, method, true);
    cd.setUint32(20, body.length, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let pos = 0;
  for (const c of all) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

const text = (s: string) => new TextEncoder().encode(s);

function docx(documentXml: Uint8Array, deflate = true): Uint8Array {
  return zip([
    {
      name: "[Content_Types].xml",
      deflate,
      data: text(
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
    },
    {
      name: "_rels/.rels",
      deflate,
      data: text(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
    },
    { name: "word/document.xml", deflate, data: documentXml },
  ]);
}

const paragraph = (s: string) => `<w:p><w:r><w:t xml:space="preserve">${s}</w:t></w:r></w:p>`;
const documentXml = (body: string) =>
  text(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);

const codeOf = async (promise: Promise<unknown>) => promise.then(() => "resolved", (error: { code?: string }) => error.code);

describe("assertZipWithinLimits", () => {
  it("accepts a deflated document and mammoth still reads it", async () => {
    const bytes = docx(documentXml(paragraph("Lee: Invoices are exported nightly.")));
    expect(() => assertZipWithinLimits(bytes)).not.toThrow();
    expect((await parseSource({ format: "docx", bytes, filename: "notes.docx" })).text).toContain("Lee: Invoices are exported nightly.");
  });

  it("rejects a high-ratio bomb before mammoth inflates it", async () => {
    // 64 MB of zeros deflates to ~64 KB, well under the 5 MB upload cap.
    const bytes = docx(new Uint8Array(64 * 1024 * 1024));
    expect(bytes.byteLength).toBeLessThan(200 * 1024);
    expect(() => assertZipWithinLimits(bytes)).toThrow(expect.objectContaining({ code: "too_large" }));
    expect(await codeOf(parseSource({ format: "docx", bytes, filename: "bomb.docx" }))).toBe("too_large");
  });

  it("checks the real inflated size, not the declared one", () => {
    const lying = zip([{ name: "word/document.xml", deflate: true, data: new Uint8Array(MAX_DOCX_UNCOMPRESSED_BYTES + 1), declaredSize: 100 }]);
    expect(() => assertZipWithinLimits(lying)).toThrow(expect.objectContaining({ code: "too_large" }));
    // The budget is shared: many parts under the limit each can still add up to too much.
    const parts = Array.from({ length: 4 }, (_, i) => ({ name: `word/media/part${i}.bin`, deflate: true, data: new Uint8Array(8 * 1024 * 1024) }));
    expect(() => assertZipWithinLimits(zip(parts))).toThrow(expect.objectContaining({ code: "too_large" }));
    expect(() => assertZipWithinLimits(zip(parts.slice(0, 3)))).not.toThrow();
  });

  it("caps the number of entries", () => {
    const many = (n: number) => zip(Array.from({ length: n }, (_, i) => ({ name: `f${i}.xml`, data: text("<a/>") })));
    expect(() => assertZipWithinLimits(many(MAX_DOCX_ENTRIES))).not.toThrow();
    expect(() => assertZipWithinLimits(many(MAX_DOCX_ENTRIES + 1))).toThrow(expect.objectContaining({ code: "too_large" }));
  });

  it("rejects truncated archives, ZIP64 markers and unknown compression as invalid_docx", () => {
    const good = docx(documentXml(paragraph("x")));
    for (const bad of [good.subarray(0, good.length - 5), good.subarray(0, 40), new Uint8Array(10)]) {
      expect(() => assertZipWithinLimits(bad)).toThrow(expect.objectContaining({ code: "invalid_docx" }));
    }
    const zip64 = good.slice();
    new DataView(zip64.buffer).setUint16(zip64.length - 22 + 10, 0xffff, true);
    expect(() => assertZipWithinLimits(zip64)).toThrow(expect.objectContaining({ code: "invalid_docx" }));
    const bzip2 = zip([{ name: "word/document.xml", data: text("<a/>") }]);
    const view = new DataView(bzip2.buffer);
    const central = view.getUint32(bzip2.length - 22 + 16, true);
    view.setUint16(central + 10, 12, true);
    expect(() => assertZipWithinLimits(bzip2)).toThrow(expect.objectContaining({ code: "invalid_docx" }));
  });

  it("rejects a document whose extracted text exceeds the byte limit", async () => {
    // Repetitive text compresses far below the limit but extracts above it.
    const bytes = docx(documentXml(paragraph("Dana: Route changes need approval. ".repeat(2000))));
    expect(bytes.byteLength).toBeLessThan(20_000);
    expect(await codeOf(parseSource({ format: "docx", bytes, filename: "long.docx", maxBytes: 20_000 }))).toBe("too_large");
    expect(await codeOf(parseSource({ format: "docx", bytes, filename: "long.docx" }))).toBe("resolved");
  });
});
