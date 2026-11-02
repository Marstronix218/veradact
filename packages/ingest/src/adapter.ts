import type { SourceFormat } from "./detect";

/**
 * Extension seam for pulling sources from other systems (ARCHITECTURE §9.1, §15).
 * There are deliberately no implementations in the MVP; every source enters through upload or
 * paste. Notes for whoever writes the first adapter:
 *
 * - Granola: use its enterprise API (workspace-level notes and transcripts), not its MCP
 *   server. The MCP server is scoped to an individual user's session and is meant for
 *   interactive assistants, not unattended server-side sync.
 * - Slack: apps not distributed through the Slack Marketplace are limited to 1 request per
 *   minute on `conversations.history` (channel history), so a sync must be incremental,
 *   cursor-based and tolerant of long backfills. Slack ingestion is out of scope for the MVP
 *   (CLAUDE.md); this note only records the constraint.
 *
 * Whatever an adapter yields goes through `parseSource`, the consent gate and the AI-off
 * check exactly like an upload; adapters never call a model.
 */
export interface IngestionAdapter {
  /** Stable adapter id, e.g. "granola". */
  readonly id: string;
  /**
   * Sources available after `cursor` (null = from the beginning), oldest first. Each yielded
   * source carries the cursor to resume after it.
   */
  listSources(cursor: string | null): AsyncIterable<RawSource>;
}

/** A source fetched from an external system, before parsing. */
export interface RawSource {
  /** Id of the source in the external system (dedupe key per adapter). */
  externalId: string;
  /** Cursor to pass to `listSources` to continue after this source. */
  cursor: string;
  format: SourceFormat;
  /** Exactly one of `bytes` / `text`, as for `parseSource`. */
  bytes?: Uint8Array;
  text?: string;
  /** Title or filename. Personal-data risk: stored in `source_content`, never in the log. */
  title: string | null;
  /** When the meeting or message happened, if the external system knows. */
  occurredAt: Date | null;
}
