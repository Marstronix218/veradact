import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { detectFormat } from "./detect";
import { IngestError } from "./errors";
import { parseSource, type ParsedSource } from "./parse";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const SEED_SOURCES = ["01-kickoff.vtt", "02-security-review.md", "03-scope-call.srt"];
const EVAL_SOURCES = ["e1-retail-kickoff.vtt", "e2-insurer-notes.md", "e3-hospital-scope.srt", "e4-bank-email.txt"];

type Normalize = (file: string, raw: string) => string;
let checkerNormalize: Normalize;

const readJson = (rel: string): unknown => JSON.parse(fs.readFileSync(path.join(FIXTURES, rel), "utf8"));

async function parseFixture(rel: string): Promise<ParsedSource> {
  const filename = path.basename(rel);
  const bytes = new Uint8Array(fs.readFileSync(path.join(FIXTURES, rel)));
  return parseSource({ format: detectFormat(filename, bytes), bytes, filename });
}

function occurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) n += 1;
  return n;
}

function speakerAt(parsed: ParsedSource, offset: number): string | null | undefined {
  return parsed.segments.find((s) => s.start <= offset && offset < s.end)?.speaker;
}

async function expectIngestError(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(IngestError);
  await expect(p).rejects.toMatchObject({ code });
}

beforeAll(async () => {
  // The fixture checker is the reference implementation of the normalization contract.
  const mod = (await import(pathToFileURL(path.join(FIXTURES, "check-fixtures.mjs")).href)) as { normalize: Normalize };
  checkerNormalize = mod.normalize;
});

describe("parseSource on fixtures", () => {
  const all = [...SEED_SOURCES.map((f) => `seed/${f}`), ...EVAL_SOURCES.map((f) => `eval/${f}`)];

  it.each(all)("%s normalizes exactly like fixtures/check-fixtures.mjs", async (rel) => {
    const parsed = await parseFixture(rel);
    const raw = fs.readFileSync(path.join(FIXTURES, rel), "utf8");
    expect(parsed.text).toBe(checkerNormalize(rel, raw));
    expect(parsed.text.length).toBeGreaterThan(500);
    expect(parsed.text).not.toMatch(/\r|-->|WEBVTT|<\/?v[ >]/);
  });

  it.each(all)("%s segments are non-empty lines with valid offsets", async (rel) => {
    const parsed = await parseFixture(rel);
    const lines = parsed.text.split("\n").filter((l) => l.trim() !== "");
    expect(parsed.segments).toHaveLength(lines.length);
    let prevEnd = -1;
    for (const seg of parsed.segments) {
      expect(seg.start).toBeGreaterThan(prevEnd);
      expect(seg.end).toBeGreaterThan(seg.start);
      const slice = parsed.text.slice(seg.start, seg.end);
      expect(slice).not.toContain("\n");
      expect(seg.start === 0 || parsed.text[seg.start - 1] === "\n").toBe(true);
      expect(seg.end === parsed.text.length || parsed.text[seg.end] === "\n").toBe(true);
      prevEnd = seg.end;
    }
  });

  it("transcript segments carry the speaker label verbatim", async () => {
    const vtt = await parseFixture("seed/01-kickoff.vtt");
    expect(vtt.segments).toHaveLength(73);
    expect(vtt.segments.every((s) => s.speaker !== null)).toBe(true);
    expect(new Set(vtt.segments.map((s) => s.speaker))).toContain("Tomás Ferreira");
    const srt = await parseFixture("seed/03-scope-call.srt");
    expect(srt.segments).toHaveLength(49);
    expect(srt.segments.every((s) => s.speaker !== null)).toBe(true);
  });

  it("every seed item quote (and followup quote) occurs exactly once, spoken by its speaker", async () => {
    type Quote = { source: string; quote: string; speaker: string | null };
    type Item = Quote & { key: string; followup?: Quote };
    const items = readJson("seed/items.json") as Item[];
    const parsed = new Map<string, ParsedSource>();
    for (const f of SEED_SOURCES) parsed.set(f, await parseFixture(`seed/${f}`));

    const quotes: Quote[] = [];
    for (const it of items) {
      if (it.source !== null) quotes.push(it);
      if (it.followup) quotes.push(it.followup);
    }
    expect(quotes.length).toBeGreaterThanOrEqual(22);
    for (const q of quotes) {
      const src = parsed.get(q.source);
      expect(src, q.source).toBeDefined();
      if (!src) continue;
      expect(occurrences(src.text, q.quote), q.quote).toBe(1);
      if (q.speaker && /\.(vtt|srt)$/.test(q.source)) {
        expect(speakerAt(src, src.text.indexOf(q.quote))).toBe(q.speaker);
      }
    }
  });

  it("md bullets with a Name: prefix get that speaker, other lines null", async () => {
    const md = await parseFixture("seed/02-security-review.md");
    const at = (needle: string) => speakerAt(md, md.text.indexOf(needle));
    expect(at("route plans, override logs")).toBe("Marcus");
    expect(at("SSO is no longer optional")).toBe("Marcus");
    expect(at("Backups follow the same")).toBeNull();
    expect(at("does the override audit trail")).toBeNull(); // "Open question:" is not a person
    expect(at("2026-09-15")).toBeNull(); // "- **Date:**"
  });

  it("every eval quote occurs exactly once, except the deliberate hallucinations which never occur", async () => {
    for (const name of EVAL_SOURCES) {
      const base = name.replace(/\.[^.]+$/, "");
      const src = await parseFixture(`eval/${name}`);
      const expected = (readJson(`eval/${base}.expected.json`) as { expected: { quote: string }[] }).expected;
      const recorded = readJson(`eval/${base}.recorded.json`) as { _notes: string[]; candidates: { quote: string }[] };
      const hallucinated = new Set(
        recorded._notes
          .map((n) => /^candidates\[(\d+)\]:\s*HALLUCINATED_QUOTE\b/.exec(n)?.[1])
          .filter((x): x is string => x !== undefined)
          .map(Number),
      );
      for (const e of expected) expect(occurrences(src.text, e.quote), e.quote).toBe(1);
      recorded.candidates.forEach((c, i) => {
        expect(occurrences(src.text, c.quote), `${base} candidates[${i}]`).toBe(hallucinated.has(i) ? 0 : 1);
      });
    }
  });
});

describe("normalization", () => {
  it("normalizes CRLF, lone CR and NFD input to NFC with \\n", async () => {
    const parsed = await parseSource({ format: "paste", text: "José: café\r\nline two\rline three\r\n" });
    expect(parsed.text).toBe("José: café\nline two\nline three\n");
    expect(parsed.text.normalize("NFC")).toBe(parsed.text);
    expect(parsed.rawText).toContain("\r\n");
    expect(parsed.segments).toEqual([
      { speaker: "José", start: 0, end: 10 },
      { speaker: null, start: 11, end: 19 },
      { speaker: null, start: 20, end: 30 },
    ]);
  });

  it("CRLF + NFD bytes in a .vtt give the same text as LF + NFC", async () => {
    const lf = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n<v Tomás Ferreira>We need SSO\nbefore go-live.</v>\n";
    const crlfNfd = "﻿" + lf.normalize("NFD").replace(/\n/g, "\r\n");
    const enc = new TextEncoder();
    const a = await parseSource({ format: "vtt", bytes: enc.encode(lf), filename: "a.vtt" });
    const b = await parseSource({ format: "vtt", bytes: enc.encode(crlfNfd), filename: "b.VTT" });
    expect(b.text).toBe(a.text);
    expect(a.text).toBe("Tomás Ferreira: We need SSO before go-live.");
    expect(b.segments).toEqual([{ speaker: "Tomás Ferreira", start: 0, end: a.text.length }]);
  });

  it("srt keeps a leading Name: verbatim and joins wrapped lines", async () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nDana Whitcombe: The first trucks\nroll at 5:30.\n\n2\n00:00:03,000 --> 00:00:04,000\nyes, agreed\n";
    const parsed = await parseSource({ format: "srt", text: srt });
    expect(parsed.text).toBe("Dana Whitcombe: The first trucks roll at 5:30.\nyes, agreed");
    expect(parsed.segments.map((s) => s.speaker)).toEqual(["Dana Whitcombe", null]);
  });

  it("offsets are UTF-16 code unit indices", async () => {
    const parsed = await parseSource({ format: "txt", text: "😀 intro\nPriya Raman: ship it 🚀\n" });
    const seg = parsed.segments[1];
    expect(seg).toBeDefined();
    if (!seg) return;
    expect(seg.start).toBe("😀 intro\n".length); // 9: the emoji is two code units
    expect(parsed.text.slice(seg.start, seg.end)).toBe("Priya Raman: ship it 🚀");
    expect(seg.speaker).toBe("Priya Raman");
  });
});

describe("input validation", () => {
  const enc = new TextEncoder();

  it("requires exactly one of bytes / text", async () => {
    await expectIngestError(parseSource({ format: "txt" }), "invalid_input");
    await expectIngestError(parseSource({ format: "txt", text: "a", bytes: enc.encode("a") }), "invalid_input");
    await expectIngestError(parseSource({ format: "docx", text: "a" }), "invalid_input");
  });

  it("enforces the size limit for bytes and text", async () => {
    await expectIngestError(parseSource({ format: "txt", text: "x".repeat(11), maxBytes: 10 }), "too_large");
    await expectIngestError(parseSource({ format: "txt", bytes: enc.encode("é".repeat(6)), maxBytes: 10 }), "too_large");
    await expect(parseSource({ format: "txt", text: "x".repeat(10), maxBytes: 10 })).resolves.toBeDefined();
  });

  it("rejects invalid UTF-8 and NUL bytes in text formats", async () => {
    await expectIngestError(parseSource({ format: "md", bytes: new Uint8Array([0x61, 0xc3, 0x28]) }), "invalid_encoding");
    await expectIngestError(parseSource({ format: "txt", bytes: enc.encode("a\u0000b") }), "invalid_encoding");
  });

  it("rejects a filename that disagrees with the format, but lets plain-text formats swap", async () => {
    await expectIngestError(parseSource({ format: "vtt", bytes: enc.encode("hello"), filename: "notes.txt" }), "unsupported_format");
    const parsed = await parseSource({ format: "md", bytes: enc.encode("hello"), filename: "notes.txt" });
    expect(parsed.text).toBe("hello");
  });

  it("rejects media bytes even without a filename", async () => {
    const id3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a]);
    await expectIngestError(parseSource({ format: "txt", bytes: id3 }), "unsupported_media");
  });

  it("rejects .docx bytes that are not a zip", async () => {
    await expectIngestError(parseSource({ format: "docx", bytes: enc.encode("not a zip") }), "invalid_docx");
    const fakeZip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6]);
    await expectIngestError(parseSource({ format: "docx", bytes: fakeZip, filename: "x.docx" }), "invalid_docx");
  });

  it("rejects an unknown format value", async () => {
    await expectIngestError(parseSource({ format: "pdf" as never, text: "a" }), "unsupported_format");
  });
});
