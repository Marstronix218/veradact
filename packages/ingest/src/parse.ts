import mammoth from "mammoth";
import {
  assertValidBytes,
  decodeUtf8,
  detectFormat,
  MAX_SOURCE_BYTES,
  SOURCE_FORMATS,
  type SourceFormat,
} from "./detect";
import { IngestError } from "./errors";
import { leadingSpeakerLabel } from "./speaker";
import { assertZipWithinLimits } from "./zip-guard";

export interface ParseSourceInput {
  format: SourceFormat;
  /** File contents (uploads). Exactly one of `bytes` / `text`. Required for docx. */
  bytes?: Uint8Array;
  /** Already-decoded text (paste, or a file read elsewhere). */
  text?: string;
  /** When given with `bytes`, the extension and magic bytes are checked against `format`. Never logged. */
  filename?: string;
  /** Byte limit; defaults to MAX_SOURCE_BYTES (5 MB). */
  maxBytes?: number;
}

/** One utterance (transcript cue) or non-empty line. Offsets are UTF-16 indices into `text`. */
export interface Segment {
  speaker: string | null;
  start: number;
  end: number;
}

export interface ParsedSource {
  /** Normalized text (NFC, `\n` line endings). Quotes and offsets always refer to this. */
  text: string;
  /** Decoded input before format processing (UTF-8, BOM removed; mammoth output for docx). Not normalized. */
  rawText: string;
  segments: Segment[];
}

/** NFC, `\r\n`/`\r` → `\n`, leading BOM removed (ARCHITECTURE §1.1). */
export function normalizeText(raw: string): string {
  return raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n").normalize("NFC");
}

const PLAIN_TEXT: ReadonlySet<SourceFormat> = new Set(["txt", "md", "paste"]);

interface Line {
  text: string;
  /** Known speaker (from a VTT voice tag); undefined → detect from a leading label. */
  speaker?: string | null;
}

// ---------------------------------------------------------------- cues (.vtt / .srt)
// Mirrors fixtures/check-fixtures.mjs exactly: blocks are separated by blank lines; a block
// is a cue when one of its lines contains "-->"; everything up to and including that timing
// line (WEBVTT header, cue id, SRT number) is dropped and the remaining lines are trimmed and
// joined with a single space. Blocks without a timing line (header, NOTE, STYLE) are skipped.

function cueTexts(text: string): string[] {
  const blocks: string[][] = [];
  let cur: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      if (cur.length) blocks.push(cur);
      cur = [];
    } else {
      cur.push(line);
    }
  }
  if (cur.length) blocks.push(cur);

  const out: string[] = [];
  for (const block of blocks) {
    const ti = block.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    out.push(
      block
        .slice(ti + 1)
        .map((l) => l.trim())
        .join(" "),
    );
  }
  return out;
}

const VOICE = /^<v(?:\.[^\s>]+)*\s+([^>]+)>([\s\S]*)$/;

function vttLine(cue: string): Line {
  const m = VOICE.exec(cue);
  if (!m) return { text: cue };
  const speaker = (m[1] ?? "").trim();
  const body = (m[2] ?? "").replace(/<\/v>\s*$/, "").trim();
  return { text: `${speaker}: ${body}`, speaker };
}

// ---------------------------------------------------------------- assembly

function fromLines(lines: Line[], allowListMarker: boolean): { text: string; segments: Segment[] } {
  let text = "";
  const segments: Segment[] = [];
  lines.forEach((line, i) => {
    if (i > 0) text += "\n";
    const start = text.length;
    text += line.text;
    if (line.text.trim() === "") return;
    const speaker = line.speaker !== undefined ? line.speaker : leadingSpeakerLabel(line.text, { allowListMarker });
    segments.push({ speaker, start, end: text.length });
  });
  return { text, segments };
}

async function docxText(bytes: Uint8Array, maxBytes: number): Promise<string> {
  // Bounds what mammoth/JSZip will inflate (decompression bombs) before it runs.
  assertZipWithinLimits(bytes);
  let text: string;
  try {
    const result = await mammoth.extractRawText({
      buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    });
    text = result.value;
  } catch {
    // mammoth's error text can quote document content; never pass it on.
    throw new IngestError("invalid_docx");
  }
  // The extracted text obeys the same limit as an uploaded text file.
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new IngestError("too_large");
  return text;
}

/**
 * Turn a source into normalized text plus utterance segments (ARCHITECTURE §9.1,
 * fixtures/README.md "Normalization contract").
 * - txt / md / paste / docx: text as given (docx via mammoth.extractRawText); one segment per non-empty line.
 * - vtt: header, cue ids and timings removed; `<v Name>text</v>` → `Name: text`; wrapped cue lines joined with a space.
 * - srt: numbers and timings removed; cue lines joined with a space; a leading `Name:` stays verbatim.
 * Throws `IngestError`.
 */
export async function parseSource(input: ParseSourceInput): Promise<ParsedSource> {
  const { format } = input;
  if (!SOURCE_FORMATS.includes(format)) throw new IngestError("unsupported_format");
  const hasBytes = input.bytes !== undefined;
  if (hasBytes === (input.text !== undefined)) throw new IngestError("invalid_input");
  const maxBytes = input.maxBytes ?? MAX_SOURCE_BYTES;

  let rawText: string;
  if (input.bytes !== undefined) {
    if (input.filename !== undefined) {
      const detected = detectFormat(input.filename, input.bytes, { maxBytes });
      if (detected !== format && !(PLAIN_TEXT.has(detected) && PLAIN_TEXT.has(format))) {
        throw new IngestError("unsupported_format");
      }
    } else {
      assertValidBytes(format, input.bytes, maxBytes);
    }
    rawText = format === "docx" ? await docxText(input.bytes, maxBytes) : decodeUtf8(input.bytes);
  } else {
    if (format === "docx") throw new IngestError("invalid_input");
    rawText = input.text ?? "";
    if (Buffer.byteLength(rawText, "utf8") > maxBytes) throw new IngestError("too_large");
  }

  const normalized = normalizeText(rawText);
  let lines: Line[];
  if (format === "vtt") lines = cueTexts(normalized).map(vttLine);
  else if (format === "srt") lines = cueTexts(normalized).map((text) => ({ text }));
  else lines = normalized.split("\n").map((text) => ({ text }));

  const { text, segments } = fromLines(lines, format !== "vtt" && format !== "srt");
  return { text, rawText, segments };
}
