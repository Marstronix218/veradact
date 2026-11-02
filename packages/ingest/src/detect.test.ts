import { describe, expect, it } from "vitest";
import { detectFormat, extensionOf, looksLikeMedia } from "./detect";
import { IngestError } from "./errors";

const enc = new TextEncoder();
const text = enc.encode("Priya Raman: hello\n");

function bytes(...parts: (string | number[])[]): Uint8Array {
  const out: number[] = [];
  for (const p of parts) out.push(...(typeof p === "string" ? Array.from(enc.encode(p)) : p));
  // pad so offset-based signatures have room
  while (out.length < 16) out.push(0);
  return new Uint8Array(out);
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof IngestError) return err.code;
    throw err;
  }
  return undefined;
}

const MEDIA_MAGIC: Record<string, Uint8Array> = {
  "mp3 (ID3)": bytes("ID3", [0x04, 0x00]),
  "mp3 (frame sync)": bytes([0xff, 0xfb, 0x90, 0x64]),
  "aac (ADTS)": bytes([0xff, 0xf1, 0x50, 0x80]),
  wav: bytes("RIFF", [0x24, 0x08, 0, 0], "WAVE", "fmt "),
  avi: bytes("RIFF", [0x24, 0x08, 0, 0], "AVI ", "LIST"),
  mp4: bytes([0, 0, 0, 0x20], "ftypisom"),
  m4a: bytes([0, 0, 0, 0x20], "ftypM4A "),
  mov: bytes([0, 0, 0, 0x14], "ftypqt  "),
  "mov (legacy moov)": bytes([0, 0, 0, 0x6c], "moov"),
  webm: bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]),
  ogg: bytes("OggS", [0x00, 0x02]),
  flac: bytes("fLaC", [0x00, 0x00, 0x00, 0x22]),
  aiff: bytes("FORM", [0, 0, 0, 0], "AIFF"),
  wma: bytes([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9]),
  mpeg: bytes([0x00, 0x00, 0x01, 0xba]),
  flv: bytes("FLV", [0x01, 0x05]),
  amr: bytes("#!AMR\n"),
};

describe("detectFormat", () => {
  it.each([
    ["notes.txt", "txt"],
    ["NOTES.TXT", "txt"],
    ["readme.markdown", "md"],
    ["call.md", "md"],
    ["kickoff.vtt", "vtt"],
    ["scope.SRT", "srt"],
    ["dir/sub.dir/file.txt", "txt"],
  ])("%s → %s", (name, format) => {
    expect(detectFormat(name, text)).toBe(format);
  });

  it("accepts a .docx that is a zip", () => {
    expect(detectFormat("spec.docx", bytes([0x50, 0x4b, 0x03, 0x04]))).toBe("docx");
  });

  it.each(["mp3", "wav", "mp4", "m4a", "webm", "ogg", "flac", "mov", "mkv", "aac", "opus", "avi", "wma", "3gp"])(
    "rejects .%s by extension as unsupported_media",
    (ext) => {
      expect(codeOf(() => detectFormat(`meeting.${ext}`, text))).toBe("unsupported_media");
      expect(codeOf(() => detectFormat(`MEETING.${ext.toUpperCase()}`, text))).toBe("unsupported_media");
    },
  );

  it.each(Object.entries(MEDIA_MAGIC))("rejects %s magic bytes as unsupported_media, whatever the extension", (_, b) => {
    expect(looksLikeMedia(b)).toBe(true);
    expect(codeOf(() => detectFormat("transcript.txt", b))).toBe("unsupported_media");
    expect(codeOf(() => detectFormat("transcript.vtt", b))).toBe("unsupported_media");
    expect(codeOf(() => detectFormat("transcript.docx", b))).toBe("unsupported_media");
    expect(codeOf(() => detectFormat("transcript.pdf", b))).toBe("unsupported_media");
  });

  it.each(["report.pdf", "app.exe", "sheet.xlsx", "page.html", "README", ".vtt", "archive.zip", "photo.png"])(
    "rejects %s as unsupported_format",
    (name) => {
      expect(codeOf(() => detectFormat(name, text))).toBe("unsupported_format");
    },
  );

  it("rejects a .docx that is not a zip", () => {
    expect(codeOf(() => detectFormat("spec.docx", text))).toBe("invalid_docx");
  });

  it("rejects text formats that are not UTF-8", () => {
    const latin1 = new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x0a]); // "Café" in Latin-1
    expect(codeOf(() => detectFormat("notes.txt", latin1))).toBe("invalid_encoding");
    const utf16 = new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]);
    expect(codeOf(() => detectFormat("notes.srt", utf16))).toBe("invalid_encoding");
  });

  it("enforces the byte limit", () => {
    expect(codeOf(() => detectFormat("notes.txt", new Uint8Array(11).fill(0x61), { maxBytes: 10 }))).toBe("too_large");
    expect(detectFormat("notes.txt", new Uint8Array(10).fill(0x61), { maxBytes: 10 })).toBe("txt");
  });

  it("does not mistake ordinary text for media", () => {
    for (const s of ["caffeine notes for the call", "ID3 rollout notes", "RIFF raff", "OggS? no", "FLV team", "MThd notes"]) {
      expect(looksLikeMedia(enc.encode(s)), s).toBe(false);
      expect(detectFormat("notes.txt", enc.encode(s))).toBe("txt");
    }
  });
});

describe("extensionOf", () => {
  it("lower-cases and ignores dotfiles and paths", () => {
    expect(extensionOf("A.B.VTT")).toBe("vtt");
    expect(extensionOf(".env")).toBe("");
    expect(extensionOf("noext")).toBe("");
    expect(extensionOf("C:\\x\\y.Md")).toBe("md");
  });
});
