import { IngestError } from "./errors";

/** Formats that arrive as files. */
export type FileFormat = "txt" | "md" | "vtt" | "srt" | "docx";
/** Every format `parseSource` accepts (`paste` = text typed or pasted into the app). */
export type SourceFormat = FileFormat | "paste";

export const SOURCE_FORMATS: readonly SourceFormat[] = ["txt", "md", "paste", "vtt", "srt", "docx"];

/** Default upload limit (bytes). Callers can pass a different `maxBytes`. */
export const MAX_SOURCE_BYTES = 5 * 1024 * 1024;

const EXTENSION_FORMATS: Record<string, FileFormat> = {
  txt: "txt",
  text: "txt",
  md: "md",
  markdown: "md",
  vtt: "vtt",
  srt: "srt",
  docx: "docx",
};

// Rejected with `unsupported_media` (not `unsupported_format`) so the UI can explain that
// Veradact never processes recordings.
const MEDIA_EXTENSIONS = new Set([
  "3g2", "3gp", "aac", "ac3", "aif", "aifc", "aiff", "alac", "amr", "ape", "asf", "avi", "caf",
  "dts", "f4a", "f4v", "flac", "flv", "m2ts", "m4a", "m4b", "m4p", "m4v", "mid", "midi", "mka",
  "mkv", "mov", "mp2", "mp3", "mp4", "mpe", "mpeg", "mpg", "mts", "oga", "ogg", "ogv", "opus",
  "qt", "ra", "rm", "rmvb", "vob", "wav", "wave", "weba", "webm", "wma", "wmv", "wv",
]);

export function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

function hasAscii(b: Uint8Array, offset: number, text: string): boolean {
  if (b.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (b[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function hasBytes(b: Uint8Array, offset: number, sig: readonly number[]): boolean {
  if (b.length < offset + sig.length) return false;
  return sig.every((v, i) => b[offset + i] === v);
}

/**
 * Magic-byte sniffing for common audio/video containers. Signatures that could plausibly
 * start a text file are tightened with a binary byte so notes like "caffeine..." pass.
 */
export function looksLikeMedia(b: Uint8Array): boolean {
  if (b.length < 4) return false;
  const b0 = b[0] ?? 0;
  const b1 = b[1] ?? 0;
  const b3 = b[3] ?? 0;
  return (
    (hasAscii(b, 0, "ID3") && b3 >= 2 && b3 <= 4) || // MP3 with ID3v2 tag
    // MPEG audio / AAC ADTS frame sync (0xFF is never UTF-8). FF FE is the UTF-16 LE BOM, left to
    // the encoding check; it would only otherwise match the long-extinct MPEG-1 Layer I.
    (b0 === 0xff && (b1 & 0xe0) === 0xe0 && b1 !== 0xfe) ||
    ((hasAscii(b, 0, "RIFF") || hasAscii(b, 0, "RF64")) &&
      (hasAscii(b, 8, "WAVE") || hasAscii(b, 8, "AVI ") || hasAscii(b, 8, "RMID"))) || // WAV, AVI
    (hasAscii(b, 0, "FORM") && (hasAscii(b, 8, "AIFF") || hasAscii(b, 8, "AIFC"))) || // AIFF
    hasAscii(b, 4, "ftyp") || // MP4, M4A, MOV, 3GP (ISO base media)
    (b0 === 0 && ["moov", "mdat", "wide", "free", "skip"].some((t) => hasAscii(b, 4, t))) || // old QuickTime
    hasBytes(b, 0, [0x1a, 0x45, 0xdf, 0xa3]) || // EBML: WebM, Matroska
    (hasAscii(b, 0, "OggS") && b[4] === 0) || // Ogg (Vorbis, Opus, Theora)
    hasAscii(b, 0, "fLaC") || // FLAC
    (hasAscii(b, 0, "caff") && b[4] === 0) || // Core Audio
    (hasAscii(b, 0, "MThd") && b[4] === 0) || // MIDI
    hasAscii(b, 0, "#!AMR") || // AMR
    (hasAscii(b, 0, "FLV") && b3 === 1) || // Flash video
    hasBytes(b, 0, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]) || // ASF: WMA, WMV
    hasBytes(b, 0, [0x00, 0x00, 0x01, 0xba]) || // MPEG program stream
    hasBytes(b, 0, [0x00, 0x00, 0x01, 0xb3]) || // MPEG video
    (hasAscii(b, 0, ".RMF") && b[4] === 0) // RealMedia
  );
}

function isZip(b: Uint8Array): boolean {
  return hasBytes(b, 0, [0x50, 0x4b, 0x03, 0x04]);
}

/** Strict UTF-8 decode (BOM removed). Rejects invalid sequences and NUL characters. */
export function decodeUtf8(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new IngestError("invalid_encoding");
  }
  // UTF-16 without a BOM decodes as "valid" UTF-8 full of NULs; no real text contains U+0000.
  if (text.includes("\u0000")) throw new IngestError("invalid_encoding");
  return text;
}

/** Size, media, container and encoding checks for bytes claimed to be `format`. */
export function assertValidBytes(format: SourceFormat, bytes: Uint8Array, maxBytes = MAX_SOURCE_BYTES): void {
  if (bytes.byteLength > maxBytes) throw new IngestError("too_large");
  if (looksLikeMedia(bytes)) throw new IngestError("unsupported_media");
  if (format === "docx") {
    if (!isZip(bytes)) throw new IngestError("invalid_docx");
    return;
  }
  decodeUtf8(bytes);
}

/**
 * Determine the file format from the filename and verify the bytes match it.
 * Throws `IngestError` with `unsupported_media` (audio/video by extension or magic bytes),
 * `unsupported_format` (unknown extension), `too_large`, `invalid_docx` or `invalid_encoding`.
 */
export function detectFormat(filename: string, bytes: Uint8Array, options: { maxBytes?: number } = {}): FileFormat {
  const ext = extensionOf(filename);
  if (MEDIA_EXTENSIONS.has(ext) || looksLikeMedia(bytes)) throw new IngestError("unsupported_media");
  const format = EXTENSION_FORMATS[ext];
  if (!format) throw new IngestError("unsupported_format");
  assertValidBytes(format, bytes, options.maxBytes);
  return format;
}
