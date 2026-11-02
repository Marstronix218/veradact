export const ingestPackageName = "@veradact/ingest";

export { parseSource, normalizeText, type ParseSourceInput, type ParsedSource, type Segment } from "./parse";
export {
  detectFormat,
  assertValidBytes,
  decodeUtf8,
  extensionOf,
  looksLikeMedia,
  MAX_SOURCE_BYTES,
  SOURCE_FORMATS,
  type FileFormat,
  type SourceFormat,
} from "./detect";
export { leadingSpeakerLabel } from "./speaker";
export { assertZipWithinLimits, MAX_DOCX_ENTRIES, MAX_DOCX_UNCOMPRESSED_BYTES, type ZipLimits } from "./zip-guard";
export { IngestError, type IngestErrorCode } from "./errors";
export type { IngestionAdapter, RawSource } from "./adapter";
