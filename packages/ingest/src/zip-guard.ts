// Decompression-bomb guard for .docx uploads. The upload cap (5 MB) limits the compressed size
// only; mammoth (via JSZip) inflates parts in memory without a limit, and deflate reaches ~1000:1.
// Before mammoth sees a file, this
//  1. checks that the central directory is one contiguous run of exactly the declared records,
//     ending at the end-of-central-directory record, with at most `maxEntries` records (cheap, and
//     before JSZip allocates anything per record);
//  2. loads the archive with JSZip itself — a direct dependency pinned to the version mammoth
//     uses — so it enumerates exactly the entries mammoth can read (a hand-written reader
//     disagreed with JSZip on records past the declared count and on bytes prepended to the
//     archive, which let a hidden entry through), then inflates every entry through JSZip's own
//     streaming decompressor against a shared budget, counting bytes as they arrive and stopping
//     at the first byte over it. Declared sizes can lie, so the real inflated size is checked,
//     and memory stays bounded by the stream's chunk size, not by the entry.
import JSZip from "jszip";
import { IngestError } from "./errors";

/** Total inflated bytes allowed across all entries of one .docx. */
export const MAX_DOCX_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;
/** Entries allowed in one .docx (real documents have a few dozen). */
export const MAX_DOCX_ENTRIES = 2000;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const ZIP64_MARKER_16 = 0xffff;
const ZIP64_MARKER_32 = 0xffffffff;

export interface ZipLimits {
  maxUncompressedBytes?: number;
  maxEntries?: number;
}

/** `internalStream` is public JSZip API, but its bundled type definitions leave it out. */
type StreamableEntry = JSZip.JSZipObject & { internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array> };

function findEndOfCentralDirectory(view: DataView): number {
  // The record is 22 bytes plus a comment of at most 65,535 bytes, at the very end.
  const lowest = Math.max(0, view.byteLength - EOCD_SIZE - 0xffff);
  for (let i = view.byteLength - EOCD_SIZE; i >= lowest; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  throw new IngestError("invalid_docx");
}

/**
 * Step 1. Throws `too_large` for more than `maxEntries` declared records and `invalid_docx` unless
 * the central directory is exactly `entries` records filling [offset, offset + size) with the
 * end-of-central-directory record right after it — then JSZip (which keeps reading records past
 * the declared count, and shifts every offset when the directory does not end at that record)
 * reads the same records. ZIP64 and multi-disk archives are refused.
 */
export function assertCentralDirectoryConsistent(bytes: Uint8Array, maxEntries: number = MAX_DOCX_ENTRIES): void {
  if (bytes.byteLength < EOCD_SIZE) throw new IngestError("invalid_docx");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entries = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (entries === ZIP64_MARKER_16 || entriesOnDisk === ZIP64_MARKER_16 || centralSize === ZIP64_MARKER_32 || centralOffset === ZIP64_MARKER_32) {
    throw new IngestError("invalid_docx");
  }
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entries) throw new IngestError("invalid_docx");
  if (entries > maxEntries) throw new IngestError("too_large");
  if (centralOffset + centralSize !== eocd) throw new IngestError("invalid_docx");

  let pos = centralOffset;
  for (let n = 0; n < entries; n += 1) {
    if (pos + CENTRAL_HEADER_SIZE > eocd || view.getUint32(pos, true) !== CENTRAL_SIGNATURE) throw new IngestError("invalid_docx");
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    pos += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
  }
  if (pos !== eocd) throw new IngestError("invalid_docx");
}

/** Inflated byte count of one entry, or `too_large` as soon as it passes `budget`. */
function inflatedSizeWithin(entry: JSZip.JSZipObject, budget: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let total = 0;
    let settled = false;
    const stream = (entry as StreamableEntry).internalStream("uint8array");
    stream
      .on("data", (chunk) => {
        if (settled) return;
        total += chunk.length;
        if (total > budget) {
          // Pausing stops the reader after the chunk being inflated; nothing is kept.
          settled = true;
          stream.pause();
          reject(new IngestError("too_large"));
        }
      })
      .on("error", () => {
        if (settled) return;
        settled = true;
        // JSZip's error text can quote entry names; never pass it on.
        reject(new IngestError("invalid_docx"));
      })
      .on("end", () => {
        if (settled) return;
        settled = true;
        resolve(total);
      })
      .resume();
  });
}

/**
 * Step 2. Loads the archive with JSZip exactly as mammoth does (`loadAsync` reads the directory and
 * local headers without inflating anything) and inflates every non-directory entry it sees
 * through `internalStream`, against one shared budget. Throws `too_large` / `invalid_docx`.
 */
export async function assertJsZipEntriesWithinLimits(bytes: Uint8Array, limits: ZipLimits = {}): Promise<void> {
  const maxBytes = limits.maxUncompressedBytes ?? MAX_DOCX_UNCOMPRESSED_BYTES;
  const maxEntries = limits.maxEntries ?? MAX_DOCX_ENTRIES;
  let zip: JSZip;
  try {
    // The same input type mammoth hands to JSZip (parse.ts); a view, not a copy.
    zip = await JSZip.loadAsync(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch {
    throw new IngestError("invalid_docx");
  }
  const entries = Object.values(zip.files);
  if (entries.length > maxEntries) throw new IngestError("too_large");
  let remaining = maxBytes;
  for (const entry of entries) {
    if (entry.dir) continue;
    remaining -= await inflatedSizeWithin(entry, remaining);
  }
}

/**
 * Throws `too_large` when the archive has more than `maxEntries` entries or inflates to more than
 * `maxUncompressedBytes` in total, and `invalid_docx` for anything JSZip cannot read or this guard
 * does not accept (an inconsistent central directory, ZIP64, multi-disk, encryption, compression
 * other than store/deflate, truncated data).
 */
export async function assertZipWithinLimits(bytes: Uint8Array, limits: ZipLimits = {}): Promise<void> {
  assertCentralDirectoryConsistent(bytes, limits.maxEntries ?? MAX_DOCX_ENTRIES);
  await assertJsZipEntriesWithinLimits(bytes, limits);
}
