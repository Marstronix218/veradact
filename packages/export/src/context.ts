/**
 * Everything an export needs beyond the replayed view, resolved by the caller (web app or MCP
 * server) from its queries. Rendering is pure: no DB access and no clock reads happen here.
 */
import type { ChainHead, SourceType, Span } from "@veradact/core";

export interface ExportEngagement {
  name: string;
  clientName: string;
  /** Immutable short code (A–Z0–9), the prefix of every short id. */
  shortCode: string;
  /** IANA time zone; dates in exports are shown in it. */
  timeZone: string;
  /**
   * Effective AI flag: `org.ai_enabled && engagement.ai_enabled`. When false, exports never contain
   * quote text (or source titles) and cite sources by type, date and character offsets (D-027).
   */
  aiEnabled: boolean;
}

export interface ExportSource {
  sourceType: SourceType;
  /** The source date (`source.occurred_at`). */
  occurredAt: Date;
  /** `source_content.title`; null when the source is redacted (or has no title). */
  title: string | null;
  /** `source.redacted_at`; null while the source text exists. */
  redactedAt: Date | null;
}

export interface ExportContext {
  engagement: ExportEngagement;
  /** The vendor org's name. */
  vendorName: string;
  /** When the export is generated (the caller's clock). */
  generatedAt: Date;
  /** The requested as-of time, or null for the current log. */
  asOf: Date | null;
  /** The current log head (`engagement_head`) at generation time. */
  head: ChainHead;
  /** Every source cited by an item version in the view, keyed by source id. */
  sources: Readonly<Record<string, ExportSource>>;
  /**
   * `source_content.text.slice(start, end)`, or null when the source is redacted or its text no
   * longer hashes to `span.source_sha256`. Never called for AI-off engagements.
   */
  quoteFor(span: Span): string | null;
  /** The contact's name, or null when the contact was erased. */
  contactName(contactId: string): string | null;
  /** A vendor user's display name, or null when unknown. */
  userName(userId: string): string | null;
}
