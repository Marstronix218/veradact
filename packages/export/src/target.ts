/**
 * Export targets (ARCHITECTURE §10, §15): one renderer per output format for the agreed view.
 * Markdown spec now; Kiro/Cursor rule files can be added to `exportTargets` later.
 */
import type { AgreedView } from "@veradact/core";
import type { ExportContext } from "./context";
import { renderSpecMarkdown, specFilename } from "./spec";

export interface ExportArtifact {
  filename: string;
  contentType: string;
  body: string;
}

export interface ExportTarget {
  id: string;
  label: string;
  render(view: AgreedView, ctx: ExportContext): ExportArtifact;
}

export const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

export const markdownSpecTarget: ExportTarget = {
  id: "markdown-spec",
  label: "Markdown spec (Spec Kit spec.md)",
  render: (view, ctx) => ({ filename: specFilename(ctx), contentType: MARKDOWN_CONTENT_TYPE, body: renderSpecMarkdown(view, ctx) }),
};

/** Every available target, in display order. */
export const exportTargets: readonly ExportTarget[] = [markdownSpecTarget];

export function getExportTarget(id: string): ExportTarget | undefined {
  return exportTargets.find((t) => t.id === id);
}
