/**
 * Per-item content shared by the spec and the record (markdown and PDF): plain, unescaped strings.
 * Applies the citation rules once: manual items, redacted sources, erased contacts and AI-off
 * (D-027: no quote text, cite type, date and character offsets instead).
 */
import { KINDS, type AgreedItem, type DependencyRef, type Kind, type NotConfirmedItem, type SpanWithCarried } from "@veradact/core";
import type { ExportContext } from "./context";
import { formatDate, REVIEW_CAUSE_TEXT, SOURCE_TYPE_LABEL } from "./format";

export const ERASED_CONTACT = "Erased contact";
export const UNKNOWN_USER = "unknown user";

export interface Citation {
  /** Source type, title (AI on, not redacted) and source date: `Human notes “Kickoff”, 2026-03-01`. */
  label: string;
  /** `characters 120–184` (UTF-16 offsets into the normalized source text, end exclusive). */
  offsets: string;
  /** Quote to show, or null (redacted, AI off, or text no longer matching its hash). */
  quote: string | null;
  /** Why a quote is missing, when that needs saying next to the citation. */
  note: string | null;
}

export interface ItemPresentation {
  shortId: string;
  kind: Kind;
  statement: string;
  version: number;
  contentHash: string;
  /** One line per needs-review reason: `upstream HALV-D1 was revised`. */
  reviewWarnings: string[];
  /** `entered manually by Alex Member (dated 2026-03-01)` for manual versions. */
  manual: string | null;
  citations: Citation[];
  /** `Alice Example (2026-03-04)` or `Erased contact (2026-03-04)`, in confirmation order. */
  confirmedBy: string[];
  /** Upstream short ids, annotated when the upstream item is not active and confirmed. */
  dependsOn: string[];
}

function citeSpan(span: SpanWithCarried, ctx: ExportContext): Citation {
  const tz = ctx.engagement.timeZone;
  const offsets = `characters ${span.start}–${span.end}`;
  const source = ctx.sources[span.source_id];
  if (!source) return { label: "Unknown source", offsets, quote: null, note: "source details unavailable" };
  const type = SOURCE_TYPE_LABEL[source.sourceType];
  const date = formatDate(source.occurredAt, tz);
  const showTitle = ctx.engagement.aiEnabled && source.redactedAt === null && source.title !== null && source.title.trim() !== "";
  const label = showTitle ? `${type} “${source.title!.trim()}”, ${date}` : `${type}, ${date}`;
  if (source.redactedAt !== null) {
    return { label, offsets, quote: null, note: `source redacted on ${formatDate(source.redactedAt, tz)}` };
  }
  // AI off: the quote is never fetched; the export header explains the omission once.
  if (!ctx.engagement.aiEnabled) return { label, offsets, quote: null, note: null };
  const quote = ctx.quoteFor(span);
  if (quote === null) {
    return { label, offsets, quote: null, note: "quote unavailable: the source text no longer matches its recorded hash" };
  }
  return { label, offsets, quote, note: null };
}

function dependencyLabel(dep: DependencyRef): string {
  const id = dep.shortId ?? "unknown item";
  if (dep.lifecycle !== null && dep.lifecycle !== "active") return `${id} (${dep.lifecycle})`;
  if (dep.status !== null && dep.status !== "confirmed") return `${id} (${dep.status})`;
  return id;
}

export function contactLabel(contactId: string, erased: boolean, ctx: ExportContext): string {
  const name = erased ? null : ctx.contactName(contactId);
  return name === null || name.trim() === "" ? ERASED_CONTACT : name.trim();
}

export function presentItem(item: AgreedItem, ctx: ExportContext): ItemPresentation {
  const tz = ctx.engagement.timeZone;
  const manual = item.manual
    ? `entered manually by ${ctx.userName(item.manual.entered_by)?.trim() || UNKNOWN_USER} (dated ${formatDate(item.occurredAt, tz)})`
    : null;
  return {
    shortId: item.shortId,
    kind: item.kind,
    statement: item.statement,
    version: item.version,
    contentHash: item.contentHash,
    reviewWarnings: item.needsReview
      ? item.reviewReasons.map((r) => `upstream ${r.upstreamShortId ?? "unknown item"} ${REVIEW_CAUSE_TEXT[r.cause]}`)
      : [],
    manual,
    citations: item.spans.map((s) => citeSpan(s, ctx)),
    confirmedBy: item.confirmations.map((c) => `${contactLabel(c.contactId, c.contactErased, ctx)} (${formatDate(c.recordedAt, tz)})`),
    dependsOn: item.dependsOn.map(dependencyLabel),
  };
}

/** Status shown in parentheses in the "do not build" list. */
export function notConfirmedStatus(item: NotConfirmedItem): string {
  if (item.revisionPending) return item.status === "disputed" ? "revision disputed; previously agreed" : "revision pending; previously agreed";
  return item.status;
}

/** Items grouped by kind in display order (problem → requirement); every kind is present. */
export function groupByKind<T extends { kind: Kind }>(items: readonly T[]): [Kind, T[]][] {
  return KINDS.map((kind) => [kind, items.filter((i) => i.kind === kind)]);
}

/** An item id to use in the agent instructions' example. */
export function exampleShortId(items: readonly { shortId: string }[], shortCode: string): string {
  return items[0]?.shortId ?? `${shortCode}-R1`;
}
