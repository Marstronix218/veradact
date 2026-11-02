/**
 * Confirmed spec as markdown (ARCHITECTURE §10): only client-confirmed item versions, for coding
 * agents. Works as a GitHub Spec Kit `spec.md` or as a file dropped into a repo.
 */
import type { AgreedView, NotConfirmedItem } from "@veradact/core";
import type { ExportContext } from "./context";
import { formatDate, formatDateTime, isoUtc, KIND_SECTION } from "./format";
import { mdBlockquote, mdCode, mdInline } from "./markdown";
import { exampleShortId, groupByKind, notConfirmedStatus, presentItem, type ItemPresentation } from "./present";

export const NOT_CONFIRMED_HEADING = "Not confirmed — do not build";

export const AI_OFF_NOTICE =
  "**AI is off for this engagement.** Source quotes are omitted; each source is cited by type, date and character offsets into its normalized text.";

/** `HALV-spec-2026-10-01.md`: the as-of date (or generation date) in the engagement time zone. */
export function specFilename(ctx: ExportContext): string {
  return `${ctx.engagement.shortCode}-spec-${formatDate(ctx.asOf ?? ctx.generatedAt, ctx.engagement.timeZone)}.md`;
}

/** A YAML front-matter scalar: JSON strings are valid YAML double-quoted scalars. */
export function yamlString(value: string): string {
  return JSON.stringify(value);
}

/** The field list for one confirmed item, under a heading of `level` (3 in the spec, 4 in the record). */
export function itemMarkdown(p: ItemPresentation, level: number): string[] {
  const out = [`${"#".repeat(level)} ${mdInline(p.shortId)} · ${mdInline(p.statement)}`, ""];
  if (p.reviewWarnings.length > 0) {
    out.push(`- **Needs review:** ${p.reviewWarnings.map(mdInline).join("; ")}. Check with the team before building on this item.`);
  }
  out.push(`- **Version:** ${p.version}`, `- **Content hash:** ${mdCode(p.contentHash)}`);
  if (p.manual) out.push(`- **Source:** ${mdInline(p.manual)}`);
  for (const c of p.citations) {
    const note = c.note ? ` — ${mdInline(c.note)}` : "";
    out.push(`- **Source:** ${mdInline(c.label)}, ${c.offsets}${note}`);
    if (c.quote !== null) out.push(mdBlockquote(c.quote, "  "));
  }
  out.push(`- **Confirmed by:** ${p.confirmedBy.length > 0 ? p.confirmedBy.map(mdInline).join(", ") : "none recorded"}`);
  if (p.dependsOn.length > 0) out.push(`- **Depends on:** ${p.dependsOn.map(mdInline).join(", ")}`);
  out.push("");
  return out;
}

/** Confirmed items grouped by kind; empty kinds say "None confirmed." */
export function agreedItemsMarkdown(view: AgreedView, ctx: ExportContext, level: number): string[] {
  const out: string[] = [];
  for (const [kind, items] of groupByKind(view.items)) {
    out.push(`${"#".repeat(level)} ${KIND_SECTION[kind]}`, "");
    if (items.length === 0) out.push("None confirmed.", "");
    for (const item of items) out.push(...itemMarkdown(presentItem(item, ctx), level + 1));
  }
  return out;
}

/** The "do not build" list: short id, statement and status only. */
export function notConfirmedMarkdown(items: readonly NotConfirmedItem[]): string[] {
  if (items.length === 0) return ["None.", ""];
  return [...items.map((i) => `- ${mdInline(i.shortId)} · ${mdInline(i.statement)} (${notConfirmedStatus(i)})`), ""];
}

export function renderSpecMarkdown(view: AgreedView, ctx: ExportContext): string {
  const e = ctx.engagement;
  const tz = e.timeZone;
  const example = exampleShortId(view.items.length > 0 ? view.items : view.notConfirmed, e.shortCode);
  const out: string[] = [
    "---",
    "veradact_export: spec",
    "format_version: 1",
    `engagement: ${yamlString(e.shortCode)}`,
    `as_of: ${yamlString(ctx.asOf ? isoUtc(ctx.asOf) : "current")}`,
    `log_head_seq: ${view.head.seq}`,
    `log_head_hash: ${yamlString(view.head.hash)}`,
    `generated_at: ${yamlString(isoUtc(ctx.generatedAt))}`,
    "---",
    "",
    `# Confirmed specification: ${mdInline(e.name)}`,
    "",
    `- **Engagement:** ${mdInline(e.name)} (${mdCode(e.shortCode)})`,
    `- **Client:** ${mdInline(e.clientName)}`,
    `- **Vendor:** ${mdInline(ctx.vendorName)}`,
    `- **Generated:** ${formatDateTime(ctx.generatedAt, tz)} (${mdCode(isoUtc(ctx.generatedAt))})`,
    `- **As of:** ${ctx.asOf ? `${formatDateTime(ctx.asOf, tz)} (${mdCode(isoUtc(ctx.asOf))})` : "current log"}`,
    `- **Log head:** seq ${view.head.seq} · ${mdCode(view.head.hash)}`,
  ];
  if (ctx.head.seq !== view.head.seq || ctx.head.hash !== view.head.hash) {
    out.push(`- **Current log head:** seq ${ctx.head.seq} · ${mdCode(ctx.head.hash)}`);
  }
  out.push(`- **Confirmed items:** ${view.items.length} · **Not confirmed:** ${view.notConfirmed.length}`, "");
  if (!e.aiEnabled) out.push(`> ${AI_OFF_NOTICE}`, "");
  out.push(
    "## Instructions for coding agents",
    "",
    "1. Build only the confirmed items below. The client confirmed each one at the version and content hash shown.",
    `2. Cite item ids such as ${mdCode(example)} in commit messages, pull request titles and pull request descriptions.`,
    `3. Do not build anything listed under "${NOT_CONFIRMED_HEADING}", even if a confirmed item seems to imply it.`,
    "4. Ids are stable: an id always refers to the same item. A confirmed item that is revised moves to the not-confirmed list until the client confirms the new version.",
    "5. An item marked **Needs review** was confirmed, but an item it depends on has changed since. Check with the team before building on it.",
    "6. If something you need is not here, ask the team instead of inferring it.",
    "",
  );
  out.push(...agreedItemsMarkdown(view, ctx, 2));
  out.push(
    `## ${NOT_CONFIRMED_HEADING}`,
    "",
    "These items exist but their current versions are not confirmed (pending, disputed, or revised after confirmation). Do not build them.",
    "",
    ...notConfirmedMarkdown(view.notConfirmed),
  );
  return `${out.join("\n").trimEnd()}\n`;
}
