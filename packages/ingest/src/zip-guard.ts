// Decompression-bomb guard for .docx uploads. The upload cap (5 MB) limits the compressed size
// only; mammoth (via JSZip) inflates parts in memory without a limit, and deflate reaches ~1000:1.
// Before mammoth sees a file, this walks the zip central directory, caps the entry count, and
// inflates every entry with zlib's `maxOutputLength` against a shared budget — so the real
// inflated size is checked (declared sizes can lie) while memory stays bounded by the budget.
import { inflateRawSync } from "node:zlib";
import { IngestError } from "./errors";

/** Total inflated bytes allowed across all entries of one .docx. */
export const MAX_DOCX_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;
/** Entries allowed in one .docx (real documents have a few dozen). */
export const MAX_DOCX_ENTRIES = 2000;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const ZIP64_MARKER_16 = 0xffff;
const ZIP64_MARKER_32 = 0xffffffff;

export interface ZipLimits {
  maxUncompressedBytes?: number;
  maxEntries?: number;
}

function findEndOfCentralDirectory(view: DataView): number {
  // The record is 22 bytes plus a comment of at most 65,535 bytes, at the very end.
  const lowest = Math.max(0, view.byteLength - EOCD_SIZE - 0xffff);
  for (let i = view.byteLength - EOCD_SIZE; i >= lowest; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  throw new IngestError("invalid_docx");
}

/**
 * Throws `too_large` when the archive has more than `maxEntries` entries or inflates to more than
 * `maxUncompressedBytes` in total, and `invalid_docx` for anything this reader does not accept
 * (truncated structures, ZIP64, encryption, compression other than store/deflate).
 */
export function assertZipWithinLimits(bytes: Uint8Array, limits: ZipLimits = {}): void {
  const maxBytes = limits.maxUncompressedBytes ?? MAX_DOCX_UNCOMPRESSED_BYTES;
  const maxEntries = limits.maxEntries ?? MAX_DOCX_ENTRIES;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const inRange = (offset: number, length: number) => offset >= 0 && length >= 0 && offset + length <= bytes.byteLength;
  if (bytes.byteLength < EOCD_SIZE) throw new IngestError("invalid_docx");

  const eocd = findEndOfCentralDirectory(view);
  const entries = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (entries === ZIP64_MARKER_16 || centralSize === ZIP64_MARKER_32 || centralOffset === ZIP64_MARKER_32) throw new IngestError("invalid_docx");
  if (entries > maxEntries) throw new IngestError("too_large");
  if (!inRange(centralOffset, centralSize)) throw new IngestError("invalid_docx");

  let remaining = maxBytes;
  let pos = centralOffset;
  for (let n = 0; n < entries; n += 1) {
    if (!inRange(pos, 46) || view.getUint32(pos, true) !== CENTRAL_SIGNATURE) throw new IngestError("invalid_docx");
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const declaredSize = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    if (flags & 0x1) throw new IngestError("invalid_docx"); // encrypted
    if (compressedSize === ZIP64_MARKER_32 || declaredSize === ZIP64_MARKER_32 || localOffset === ZIP64_MARKER_32) throw new IngestError("invalid_docx");
    if (declaredSize > remaining) throw new IngestError("too_large");

    // Data starts after the local header, whose name/extra lengths may differ from the central ones.
    if (!inRange(localOffset, 30) || view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) throw new IngestError("invalid_docx");
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    if (!inRange(dataStart, compressedSize)) throw new IngestError("invalid_docx");
    const data = bytes.subarray(dataStart, dataStart + compressedSize);

    let inflated: number;
    if (method === 0) {
      inflated = compressedSize;
    } else if (method === 8) {
      try {
        // One byte over the budget is enough to know it is too large.
        inflated = inflateRawSync(data, { maxOutputLength: remaining + 1 }).byteLength;
      } catch (error) {
        throw new IngestError((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" ? "too_large" : "invalid_docx");
      }
    } else {
      throw new IngestError("invalid_docx");
    }
    if (inflated > remaining) throw new IngestError("too_large");
    remaining -= inflated;
    pos += 46 + nameLength + extraLength + commentLength;
  }
}
