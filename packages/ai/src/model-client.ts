import { z } from "zod";

// Model-provider seam (ARCHITECTURE §9.3, §15). Everything a provider returns is untrusted:
// candidates are shape-checked here and verified against the source text in verify.ts.

export const ITEM_KINDS = ["problem", "constraint", "assumption", "decision", "requirement"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export type SourceType = "human_notes" | "machine_transcript" | "email" | "chat_export";

/** An active ledger item the model may revise or depend on (statements are vendor-authored). */
export interface ExistingItem {
  short_id: string;
  kind: ItemKind;
  status: string;
  statement: string;
}

export interface ExtractionInput {
  /** Normalized source text from @veradact/ingest. Offsets in results refer to this string. */
  sourceText: string;
  sourceType: SourceType;
  existingItems: ExistingItem[];
  /** Prompt version string as stored on extraction_run, e.g. "extract.v1". */
  promptVersion: string;
}

/**
 * One candidate as proposed by a model. Deliberately loose (kind is any string, offsets may be
 * wrong): `verifyCandidates` decides what survives. Ordinal references in
 * `suggested_depends_on` ("#3") are 1-based positions in the returned array.
 */
export const RawCandidateSchema = z.object({
  kind: z.string(),
  statement: z.string(),
  quote: z.string(),
  start: z.number().int(),
  end: z.number().int(),
  speaker_label: z.string().nullable(),
  confidence: z.number(),
  suggested_depends_on: z.array(z.string()),
  revises: z.string().nullable(),
});
export type RawCandidate = z.infer<typeof RawCandidateSchema>;

export const RawCandidateListSchema = z.array(RawCandidateSchema);

export interface ModelClient {
  /** Identifier stored on extraction_run.model (the model id for real providers). */
  readonly name: string;
  extract(input: ExtractionInput): Promise<RawCandidate[]>;
}

export type ModelErrorCode =
  | "missing_api_key"
  | "auth_failed"
  | "permission_denied"
  | "bad_request"
  | "not_found"
  | "rate_limited"
  | "overloaded"
  | "server_error"
  | "timeout"
  | "connection_failed"
  | "aborted"
  | "refused"
  | "output_truncated"
  | "context_exceeded"
  | "no_tool_call"
  | "invalid_output"
  | "no_recording"
  | "unknown";

const RETRYABLE: ReadonlySet<ModelErrorCode> = new Set([
  "rate_limited",
  "overloaded",
  "server_error",
  "timeout",
  "connection_failed",
  "no_tool_call",
]);

/**
 * Coded model error. The message is derived from the code only: provider error text can echo
 * request content, so it is never copied here. Safe to log (code, status, requestId are ids).
 */
export class ModelClientError extends Error {
  readonly code: ModelErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly requestId: string | null;

  constructor(code: ModelErrorCode, details: { status?: number | null; requestId?: string | null } = {}) {
    super(`Model call failed: ${code}${details.status ? ` (HTTP ${details.status})` : ""}`);
    this.name = "ModelClientError";
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    this.status = details.status ?? null;
    this.requestId = details.requestId ?? null;
  }
}
