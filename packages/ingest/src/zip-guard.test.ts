import { once } from "node:events";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { createDeflateRaw, deflateRawSync } from "node:zlib";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { parseSource } from "./parse";
import {
  assertCentralDirectoryConsistent,
  assertJsZipEntriesWithinLimits,
  assertZipWithinLimits,
  MAX_DOCX_ENTRIES,
  MAX_DOCX_UNCOMPRESSED_BYTES,
} from "./zip-guard";

// Synthetic archives built in memory (no binary fixtures). CRCs are left 0: the guard does not
// check them, and mammoth/JSZip does not either by default.

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
  let pos = 0;
  for (const c of parts) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

function localHeader(name: Uint8Array, method: number, body: Uint8Array, size: number): Uint8Array {
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, 20, true);
  local.setUint16(8, method, true);
  local.setUint32(18, body.length, true);
  local.setUint32(22, size, true);
  local.setUint16(26, name.length, true);
  return concat([new Uint8Array(local.buffer), name, body]);
}

function centralHeader(name: Uint8Array, method: number, body: Uint8Array, size: number, localOffset: number, commentLength = 0): Uint8Array {
  const cd = new DataView(new ArrayBuffer(46));
  cd.setUint32(0, 0x02014b50, true);
  cd.setUint16(4, 20, true);
  cd.setUint16(6, 20, true);
  cd.setUint16(10, method, true);
  cd.setUint32(20, body.length, true);
  cd.setUint32(24, size, true);
  cd.setUint16(28, name.length, true);
  cd.setUint16(32, commentLength, true);
  cd.setUint32(42, localOffset, true);
  return concat([new Uint8Array(cd.buffer), name, new Uint8Array(commentLength).fill(0x20)]);
}

function endOfCentralDirectory(entries: number, centralSize: number, centralOffset: number): Uint8Array {
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries, true);
  eocd.setUint16(10, entries, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, centralOffset, true);
  return new Uint8Array(eocd.buffer);
}

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
    const local = localHeader(name, method, body, size);
    chunks.push(local);
    central.push(centralHeader(name, method, body, size, offset));
    offset += local.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  return concat([...chunks, ...central, endOfCentralDirectory(entries.length, cdSize, offset)]);
}

const text = (s: string) => new TextEncoder().encode(s);

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const RELS =
  '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';

function docx(documentXml: Uint8Array, deflate = true): Uint8Array {
  return zip([
    { name: "[Content_Types].xml", deflate, data: text(CONTENT_TYPES) },
    { name: "_rels/.rels", deflate, data: text(RELS) },
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
    await expect(assertZipWithinLimits(bytes)).resolves.toBeUndefined();
    expect((await parseSource({ format: "docx", bytes, filename: "notes.docx" })).text).toContain("Lee: Invoices are exported nightly.");
  });

  it("accepts a document written by a real zip writer (CRCs, folder entries) and mammoth reads it", async () => {
    const z = new JSZip();
    z.file("[Content_Types].xml", CONTENT_TYPES);
    z.file("_rels/.rels", RELS);
    z.file("word/document.xml", documentXml(paragraph("Mo: Carriers upload manifests by noon.")));
    const bytes = await z.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    expect(Object.values((await JSZip.loadAsync(bytes)).files).some((f) => f.dir)).toBe(true);
    await expect(assertZipWithinLimits(bytes)).resolves.toBeUndefined();
    expect((await parseSource({ format: "docx", bytes, filename: "notes.docx" })).text).toContain("Mo: Carriers upload manifests by noon.");
  });

  it("rejects a high-ratio bomb before mammoth inflates it", async () => {
    // 64 MB of zeros deflates to ~64 KB, well under the 5 MB upload cap.
    const bytes = docx(new Uint8Array(64 * 1024 * 1024));
    expect(bytes.byteLength).toBeLessThan(200 * 1024);
    expect(await codeOf(assertZipWithinLimits(bytes))).toBe("too_large");
    expect(await codeOf(parseSource({ format: "docx", bytes, filename: "bomb.docx" }))).toBe("too_large");
  });

  it("checks the real inflated size, not the declared one", async () => {
    const lying = zip([{ name: "word/document.xml", deflate: true, data: new Uint8Array(MAX_DOCX_UNCOMPRESSED_BYTES + 1), declaredSize: 100 }]);
    expect(await codeOf(assertZipWithinLimits(lying))).toBe("too_large");
    // The budget is shared: many parts under the limit each can still add up to too much.
    const parts = Array.from({ length: 4 }, (_, i) => ({ name: `word/media/part${i}.bin`, deflate: true, data: new Uint8Array(8 * 1024 * 1024) }));
    expect(await codeOf(assertZipWithinLimits(zip(parts)))).toBe("too_large");
    expect(await codeOf(assertZipWithinLimits(zip(parts.slice(0, 3))))).toBe("resolved");
  });

  it("caps the number of entries", async () => {
    const many = (n: number) => zip(Array.from({ length: n }, (_, i) => ({ name: `f${i}.xml`, data: text("<a/>") })));
    expect(await codeOf(assertZipWithinLimits(many(MAX_DOCX_ENTRIES)))).toBe("resolved");
    expect(await codeOf(assertZipWithinLimits(many(MAX_DOCX_ENTRIES + 1)))).toBe("too_large");
    // The JSZip pass enforces the cap on its own view too.
    expect(await codeOf(assertJsZipEntriesWithinLimits(many(11), { maxEntries: 10 }))).toBe("too_large");
  });

  it("rejects truncated archives, ZIP64 markers and unknown compression as invalid_docx", async () => {
    const good = docx(documentXml(paragraph("x")));
    for (const bad of [good.subarray(0, good.length - 5), good.subarray(0, 40), new Uint8Array(10)]) {
      expect(await codeOf(assertZipWithinLimits(bad))).toBe("invalid_docx");
    }
    const zip64 = good.slice();
    new DataView(zip64.buffer).setUint16(zip64.length - 22 + 10, 0xffff, true);
    expect(await codeOf(assertZipWithinLimits(zip64))).toBe("invalid_docx");
    const bzip2 = zip([{ name: "word/document.xml", data: text("<a/>") }]);
    const view = new DataView(bzip2.buffer);
    const central = view.getUint32(bzip2.length - 22 + 16, true);
    view.setUint16(central + 10, 12, true);
    expect(await codeOf(assertZipWithinLimits(bzip2))).toBe("invalid_docx");
  });

  it("rejects a central directory that is not exactly the declared records right before the end record", async () => {
    const good = docx(documentXml(paragraph("x")));
    expect(() => assertCentralDirectoryConsistent(good)).not.toThrow();
    // Bytes prepended (JSZip would silently shift every offset by them).
    expect(await codeOf(assertZipWithinLimits(concat([new Uint8Array(64), good])))).toBe("invalid_docx");
    // A gap between the directory and the end record.
    const eocdAt = good.length - 22;
    expect(await codeOf(assertZipWithinLimits(concat([good.subarray(0, eocdAt), new Uint8Array(8), good.subarray(eocdAt)])))).toBe("invalid_docx");
    // Per-disk and total entry counts that disagree.
    const disks = good.slice();
    new DataView(disks.buffer).setUint16(eocdAt + 8, 2, true);
    expect(await codeOf(assertZipWithinLimits(disks))).toBe("invalid_docx");
    // Fewer records declared than present (both counts and the size agree with each other).
    const fewer = good.slice();
    new DataView(fewer.buffer).setUint16(eocdAt + 8, 2, true);
    new DataView(fewer.buffer).setUint16(eocdAt + 10, 2, true);
    expect(await codeOf(assertZipWithinLimits(fewer))).toBe("invalid_docx");
  });

  it("rejects a document whose extracted text exceeds the byte limit", async () => {
    // Repetitive text compresses far below the limit but extracts above it.
    const bytes = docx(documentXml(paragraph("Dana: Route changes need approval. ".repeat(2000))));
    expect(bytes.byteLength).toBeLessThan(20_000);
    expect(await codeOf(parseSource({ format: "docx", bytes, filename: "long.docx", maxBytes: 20_000 }))).toBe("too_large");
    expect(await codeOf(parseSource({ format: "docx", bytes, filename: "long.docx" }))).toBe("resolved");
  });

  it("uses the same jszip package as mammoth", () => {
    // The guard is only sound if it parses archives exactly like mammoth's JSZip.
    const require = createRequire(import.meta.url);
    const ours = realpathSync(require.resolve("jszip/package.json"));
    const mammoths = realpathSync(createRequire(require.resolve("mammoth")).resolve("jszip/package.json"));
    expect(ours).toBe(mammoths);
  });
});

// ------------------------------------------------------------------------------------------------
// Archives where a hand-written central-directory walk and JSZip see different entries (review
// finding): the old guard checked a harmless entry while mammoth's JSZip inflated a hidden bomb.

const BOMB_BYTES = 200 * 1024 * 1024;

/** Raw deflate of `size` zero bytes, streamed so the test never holds the inflated data. */
async function deflatedZeros(size: number): Promise<Uint8Array> {
  const chunk = new Uint8Array(1024 * 1024);
  const deflate = createDeflateRaw({ level: 9 });
  const out: Buffer[] = [];
  deflate.on("data", (c: Buffer) => out.push(c));
  const ended = once(deflate, "end");
  for (let left = size; left > 0; left -= chunk.length) {
    if (!deflate.write(left >= chunk.length ? chunk : chunk.subarray(0, left))) await once(deflate, "drain");
  }
  deflate.end();
  await ended;
  return new Uint8Array(Buffer.concat(out));
}

let bombBody: Promise<Uint8Array> | undefined;
const bomb = () => (bombBody ??= deflatedZeros(BOMB_BYTES));
const DOCUMENT = text("word/document.xml");
const HELLO = text("hello");

/** The EOCD declares one entry; a second central record (the bomb) follows it, and JSZip reads it. */
async function recordsPastDeclaredCount(): Promise<Uint8Array> {
  const body = await bomb();
  const harmless = localHeader(text("a.txt"), 0, HELLO, HELLO.length);
  const hidden = localHeader(DOCUMENT, 8, body, BOMB_BYTES);
  const central = concat([centralHeader(text("a.txt"), 0, HELLO, HELLO.length, 0), centralHeader(DOCUMENT, 8, body, BOMB_BYTES, harmless.length)]);
  return concat([harmless, hidden, central, endOfCentralDirectory(1, central.length, harmless.length + hidden.length)]);
}

/**
 * A decoy archive in prepended bytes: the EOCD's offsets point into the prefix (a harmless entry),
 * but because the directory does not end at the EOCD, JSZip shifts every offset by the prefix
 * length and reads the real directory (the bomb).
 */
async function decoyDirectoryInPrefix(): Promise<Uint8Array> {
  const body = await bomb();
  const bombLocal = localHeader(DOCUMENT, 8, body, BOMB_BYTES);
  const bombCentral = centralHeader(DOCUMENT, 8, body, BOMB_BYTES, 0, 10);
  const decoyLocal = localHeader(text("a.txt"), 0, HELLO, HELLO.length);
  // Same record length as the bomb's, so the EOCD's size fits both directories.
  const decoyCentral = centralHeader(text("a.txt"), 0, HELLO, HELLO.length, 0, 10 + DOCUMENT.length - "a.txt".length);
  expect(decoyCentral.length).toBe(bombCentral.length);
  const centralOffset = bombLocal.length;
  const prefix = concat([decoyLocal, new Uint8Array(centralOffset - decoyLocal.length), decoyCentral]);
  return concat([prefix, bombLocal, bombCentral, endOfCentralDirectory(1, bombCentral.length, centralOffset)]);
}

/** Runs `fn` and reports the largest growth of JS heap + array buffers seen while it ran, in MB. */
async function peakGrowthMb(fn: () => Promise<unknown>): Promise<{ code: string | undefined; growthMb: number }> {
  const used = () => {
    const m = process.memoryUsage();
    return m.heapUsed + m.arrayBuffers;
  };
  const before = used();
  let peak = before;
  const timer = setInterval(() => {
    peak = Math.max(peak, used());
  }, 1);
  try {
    const code = await codeOf(fn());
    peak = Math.max(peak, used());
    return { code, growthMb: (peak - before) / (1024 * 1024) };
  } finally {
    clearInterval(timer);
  }
}

describe("archives a hand-written zip reader and JSZip disagree on", () => {
  for (const [label, build] of [
    ["central records past the declared entry count", recordsPastDeclaredCount],
    ["a decoy central directory in prepended bytes", decoyDirectoryInPrefix],
  ] as const) {
    it(`rejects ${label} before mammoth runs`, async () => {
      const bytes = await build();
      expect(bytes.byteLength).toBeLessThan(MAX_DOCX_UNCOMPRESSED_BYTES);
      // JSZip (mammoth's reader) really sees the bomb as word/document.xml.
      const seen = await JSZip.loadAsync(bytes);
      expect(Object.keys(seen.files)).toContain("word/document.xml");
      // The structural check refuses the inconsistent directory outright...
      expect(() => assertCentralDirectoryConsistent(bytes)).toThrow(expect.objectContaining({ code: "invalid_docx" }));
      expect(await codeOf(assertZipWithinLimits(bytes))).toBe("invalid_docx");
      expect(await codeOf(parseSource({ format: "docx", bytes, filename: "bomb.docx" }))).toBe("invalid_docx");
    });

    it(`stops inflating ${label} at the budget, with bounded memory, on JSZip's own view`, async () => {
      const bytes = await build();
      // ...and the JSZip pass alone (what the budget is enforced on) finds the hidden entry and
      // stops at the budget instead of buffering 200 MB.
      const { code, growthMb } = await peakGrowthMb(() => assertJsZipEntriesWithinLimits(bytes));
      expect(code).toBe("too_large");
      expect(growthMb).toBeLessThan(64);
    });
  }
});
