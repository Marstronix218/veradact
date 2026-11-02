// Confirmed spec from the stored log (ARCHITECTURE §5.4, §10): the agreed view at `asOf` (or now).
import { asOf as replayAsOf, readEvents, type AgreedView } from "@veradact/core";
import type { Tx } from "@veradact/db";
import type { ExportContext } from "../context";
import { renderSpecMarkdown, specFilename } from "../spec";
import { currentCut } from "./as-of";
import { loadExportContext } from "./context";

export interface LoadSpecInput {
  engagementId: string;
  /** Replay cut-off on `recorded_at`; null/omitted = the whole current log (see `currentCut`). */
  asOf?: Date | null;
  clock: () => Date;
}

export interface LoadedSpec {
  markdown: string;
  filename: string;
  view: AgreedView;
  ctx: ExportContext;
}

/**
 * `asOf(events, T, 'agreed')` rendered as the spec markdown, with T = `asOf`, or without one the
 * whole log (T = the later of now and the last `recorded_at`, which may run ahead of this clock).
 */
export async function loadSpec(tx: Tx, input: LoadSpecInput): Promise<LoadedSpec> {
  const ctx = await loadExportContext(tx, { engagementId: input.engagementId, clock: input.clock, asOf: input.asOf ?? null });
  const events = await readEvents(tx, input.engagementId, ctx.asOf ? { recordedAtOrBefore: ctx.asOf } : {});
  const t = ctx.asOf ?? currentCut(ctx.generatedAt, events);
  const view = replayAsOf(events, t, "agreed");
  return { markdown: renderSpecMarkdown(view, ctx), filename: specFilename(ctx), view, ctx };
}
