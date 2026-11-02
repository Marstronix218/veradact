// Coded ingest errors. Messages are fixed strings: they never contain source text,
// filenames or other user-supplied content, so they are safe to log and to show.

export type IngestErrorCode =
  | "unsupported_media" // audio or video (by extension or magic bytes)
  | "unsupported_format" // extension or format we do not parse
  | "too_large" // over the byte limit
  | "invalid_encoding" // text format that is not valid UTF-8 (or contains NUL)
  | "invalid_docx" // .docx that is not a readable Word document
  | "invalid_input"; // caller error: wrong combination of bytes/text/format

const MESSAGES: Record<IngestErrorCode, string> = {
  unsupported_media:
    "Audio and video files are not supported. Upload a transcript (.vtt, .srt), notes (.txt, .md, .docx) or paste the text.",
  unsupported_format: "Unsupported file type. Supported: .txt, .md, .vtt, .srt, .docx, or pasted text.",
  too_large: "The source is larger than the size limit.",
  invalid_encoding: "Text files must be UTF-8 encoded.",
  invalid_docx: "The .docx file could not be read as a Word document.",
  invalid_input: "Provide exactly one of bytes or text; .docx sources need bytes.",
};

export class IngestError extends Error {
  readonly code: IngestErrorCode;

  constructor(code: IngestErrorCode) {
    super(MESSAGES[code]);
    this.name = "IngestError";
    this.code = code;
  }
}
