// Source read helpers (ARCHITECTURE §2.3, §2.4, §13). Text is returned only while it exists and
// matches the recorded content hash.
import { and, asc, eq, sql } from "drizzle-orm";
import { item, itemVersion, source, sourceContent, type Tx } from "@veradact/db";
import { sha256Hex, type Attestation, type SourceFormat, type SourceRedactionReason, type SourceType } from "../domain";

export interface SourceListRow {
  id: string;
  sourceType: SourceType;
  format: SourceFormat;
  occurredAt: Date;
  recordedAt: Date;
  contentSha256: string;
  charLength: number;
  participantCount: number;
  ingestedBy: string;
  attestation: Attestation;
  redactedAt: Date | null;
  redactionReason: SourceRedactionReason | null;
  /** From `source_content`; null after redaction. */
  title: string | null;
  filename: string | null;
}

/** The engagement's sources, oldest recorded first. */
export async function listSources(tx: Tx, engagementId: string): Promise<SourceListRow[]> {
  const rows = await tx
    .select({
      id: source.id,
      sourceType: source.sourceType,
      format: source.format,
      occurredAt: source.occurredAt,
      recordedAt: source.recordedAt,
      contentSha256: source.contentSha256,
      charLength: source.charLength,
      participantCount: source.participantCount,
      ingestedBy: source.ingestedBy,
      attestation: source.attestation,
      redactedAt: source.redactedAt,
      redactionReason: source.redactionReason,
      title: sourceContent.title,
      filename: sourceContent.filename,
    })
    .from(source)
    .leftJoin(sourceContent, eq(sourceContent.sourceId, source.id))
    .where(eq(source.engagementId, engagementId))
    .orderBy(asc(source.recordedAt), asc(source.id));
  return rows.map((r) => ({ ...r, attestation: r.attestation as Attestation }));
}

export interface SourceCitation {
  itemId: string;
  shortId: string;
  version: number;
  /** The citing version is the item's current version. */
  current: boolean;
  start: number;
  end: number;
}

export interface SourceDetail extends SourceListRow {
  /** Null after redaction. `integrity` is `mismatch` when the stored text no longer hashes to `contentSha256`. */
  content: {
    text: string;
    rawText: string;
    participants: unknown;
    segments: { speaker: string | null; start: number; end: number }[];
    integrity: "verified" | "mismatch";
  } | null;
  /** Every item version span that cites this source (for highlighting), in item/version order. */
  citations: SourceCitation[];
}

export async function getSourceDetail(tx: Tx, engagementId: string, sourceId: string): Promise<SourceDetail | null> {
  const rows = await listSources(tx, engagementId);
  const row = rows.find((r) => r.id === sourceId);
  if (!row) return null;
  const [content] = await tx.select().from(sourceContent).where(eq(sourceContent.sourceId, sourceId));
  const versions = await tx
    .select({ itemId: itemVersion.itemId, version: itemVersion.version, spans: itemVersion.spans, shortId: item.shortId, currentVersion: item.currentVersion })
    .from(itemVersion)
    .innerJoin(item, eq(item.id, itemVersion.itemId))
    .where(and(eq(itemVersion.engagementId, engagementId), sql`${itemVersion.spans} @> ${JSON.stringify([{ source_id: sourceId }])}::jsonb`))
    .orderBy(asc(item.shortId), asc(itemVersion.version));
  const citations: SourceCitation[] = versions.flatMap((v) =>
    (v.spans as { source_id: string; start: number; end: number }[])
      .filter((s) => s.source_id === sourceId)
      .map((s) => ({ itemId: v.itemId, shortId: v.shortId, version: v.version, current: v.version === v.currentVersion, start: s.start, end: s.end })),
  );
  return {
    ...row,
    content: content
      ? {
          text: content.text,
          rawText: content.rawText,
          participants: content.participants,
          segments: content.segments as { speaker: string | null; start: number; end: number }[],
          integrity: sha256Hex(content.text) === row.contentSha256 ? "verified" : "mismatch",
        }
      : null,
    citations,
  };
}
