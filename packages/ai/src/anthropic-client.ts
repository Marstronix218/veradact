import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { chunkText, rebaseCandidates } from "./chunk";
import {
  ITEM_KINDS,
  ModelClientError,
  RawCandidateListSchema,
  type ExtractionInput,
  type ModelClient,
  type ModelErrorCode,
  type RawCandidate,
} from "./model-client";
import { loadPrompt, parsePromptVersion, type LoadedPrompt } from "./prompts";

/** Fallback only; the model always comes from options or ANTHROPIC_MODEL. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";
export const DEFAULT_MAX_TOKENS = 16_000;
export const DEFAULT_MAX_CHUNK_CHARS = 30_000;
export const RECORD_CANDIDATES_TOOL_NAME = "record_candidates";

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };

/** Tool whose input is the candidate list (strict: the API guarantees schema-valid input). */
export const RECORD_CANDIDATES_TOOL: Anthropic.Tool = {
  name: RECORD_CANDIDATES_TOOL_NAME,
  description:
    "Record the agreement-item candidates found in the source part, in source order. Call exactly once; pass an empty list when there are none.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      candidates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: [...ITEM_KINDS] },
            statement: { type: "string", description: "One neutral, self-contained sentence." },
            quote: { type: "string", description: "Verbatim contiguous text from one utterance, no speaker label, <= 300 chars." },
            start: { type: "integer", description: "Approximate offset of the quote within the source part." },
            end: { type: "integer", description: "start + quote length." },
            speaker_label: { ...nullableString, description: "Leading label of the quote's line, exactly as written." },
            confidence: { type: "number", description: "0 to 1." },
            suggested_depends_on: {
              type: "array",
              items: { type: "string" },
              description: "Existing short ids or #n (1-based position in this list).",
            },
            revises: { ...nullableString, description: "short_id of the existing item this revises, or null." },
          },
          required: [
            "kind",
            "statement",
            "quote",
            "start",
            "end",
            "speaker_label",
            "confidence",
            "suggested_depends_on",
            "revises",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["candidates"],
    additionalProperties: false,
  },
};

const ToolInputSchema = z.object({ candidates: RawCandidateListSchema });

/**
 * Models that reject a forced `tool_choice` ({type:"tool"} / {type:"any"} return HTTP 400):
 * Claude Opus 5.5, Sonnet 5.5, Fable 5.1, Mythos 5.1. For these the call is steered with
 * `tool_choice: auto` + the prompt, `strict: true` keeps the input schema-valid, and a
 * response without the tool call is retried once.
 */
const NO_FORCED_TOOL_CHOICE = /claude-(?:opus-5-5|sonnet-5-5|fable-5-1|mythos-5-1)(?![\w.])/;

export function supportsForcedToolChoice(model: string): boolean {
  return !NO_FORCED_TOOL_CHOICE.test(model);
}

/** The slice of the SDK client this class uses; inject a real `Anthropic` (e.g. with a fake `fetch`) in tests. */
export interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): PromiseLike<Anthropic.Message>;
  };
}

/** Structured log hook. Fields are ids, enums and counts only — never source text or quotes. */
export type ModelLogFn = (event: string, fields: Record<string, string | number | boolean | null>) => void;

export interface AnthropicModelClientOptions {
  /** Defaults to process.env.ANTHROPIC_API_KEY. Ignored when `client` is given. */
  apiKey?: string;
  /** Defaults to process.env.ANTHROPIC_MODEL, then DEFAULT_ANTHROPIC_MODEL. */
  model?: string;
  /** Non-streaming request: keep at or below ~21k or the SDK refuses (it requires streaming beyond that). */
  maxTokens?: number;
  /** Max characters of source text per request; longer sources are chunked on line boundaries. */
  maxChunkChars?: number;
  /** Override the per-model default (forced where the model supports it). */
  toolChoice?: "forced" | "auto";
  /** SDK request timeout per attempt (ms). SDK default: 10 minutes — too long for a synchronous web request. */
  timeoutMs?: number;
  /** SDK retries for 408/409/429/5xx and connection errors. SDK default: 2. */
  maxRetries?: number;
  /** SDK client (tests). Without it one is constructed lazily on the first extract() call. */
  client?: MessagesClient;
  /** Directory holding prompt files (defaults to packages/ai/prompts). */
  promptsDir?: string;
  log?: ModelLogFn;
}

export class AnthropicModelClient implements ModelClient {
  readonly name: string;
  readonly model: string;
  private readonly maxTokens: number;
  private readonly maxChunkChars: number;
  private readonly forced: boolean;
  private readonly apiKey: string | undefined;
  private readonly sdkOptions: { timeout?: number; maxRetries?: number };
  private readonly promptsDir: string | undefined;
  private readonly log: ModelLogFn;
  private client: MessagesClient | undefined;

  constructor(options: AnthropicModelClientOptions = {}) {
    this.model = options.model || process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
    this.name = this.model;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.maxChunkChars = options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
    this.forced = (options.toolChoice ?? (supportsForcedToolChoice(this.model) ? "forced" : "auto")) === "forced";
    this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.sdkOptions = {
      ...(options.timeoutMs !== undefined && { timeout: options.timeoutMs }),
      ...(options.maxRetries !== undefined && { maxRetries: options.maxRetries }),
    };
    this.promptsDir = options.promptsDir;
    this.log = options.log ?? (() => {});
    this.client = options.client;
  }

  async extract(input: ExtractionInput): Promise<RawCandidate[]> {
    const { name, version } = parsePromptVersion(input.promptVersion);
    const prompt = loadPrompt(name, version, { dir: this.promptsDir });
    const client = this.getClient();
    const chunks = chunkText(input.sourceText, this.maxChunkChars);
    const results: RawCandidate[] = [];

    for (const [i, chunk] of chunks.entries()) {
      if (chunk.text.trim() === "") continue;
      const candidates = await this.extractChunk(client, prompt, input, chunk.text, i, chunks.length);
      results.push(...rebaseCandidates(candidates, chunk.offset, results.length));
    }
    this.log("ai.extract.done", { model: this.model, chunks: chunks.length, candidates: results.length });
    return results;
  }

  private getClient(): MessagesClient {
    if (this.client) return this.client;
    if (!this.apiKey) throw new ModelClientError("missing_api_key");
    this.client = new Anthropic({ apiKey: this.apiKey, ...this.sdkOptions });
    return this.client;
  }

  private buildRequest(prompt: LoadedPrompt, input: ExtractionInput, text: string, part: number, parts: number) {
    const existing = input.existingItems.length
      ? JSON.stringify(input.existingItems.map(({ short_id, kind, status, statement }) => ({ short_id, kind, status, statement })))
      : "None.";
    const partLine =
      parts > 1
        ? `This is part ${part + 1} of ${parts} of a longer source. Offsets count from the start of this part.`
        : "This is the complete source.";
    const user = [
      `Source type: ${input.sourceType}`,
      partLine,
      `Existing active items: ${existing}`,
      "",
      `<source>\n${text}\n</source>`,
      "",
      `Call ${RECORD_CANDIDATES_TOOL_NAME} exactly once with every candidate from this source${parts > 1 ? " part" : ""}.`,
    ].join("\n");

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: this.maxTokens,
      // Stable prefix (tools + system) so repeated chunks and runs hit the prompt cache.
      system: [{ type: "text", text: prompt.text, cache_control: { type: "ephemeral" } }],
      tools: [RECORD_CANDIDATES_TOOL],
      tool_choice: this.forced
        ? { type: "tool", name: RECORD_CANDIDATES_TOOL_NAME, disable_parallel_tool_use: true }
        : { type: "auto", disable_parallel_tool_use: true },
      messages: [{ role: "user", content: user }],
    };
    return params;
  }

  private async extractChunk(
    client: MessagesClient,
    prompt: LoadedPrompt,
    input: ExtractionInput,
    text: string,
    part: number,
    parts: number,
  ): Promise<RawCandidate[]> {
    const params = this.buildRequest(prompt, input, text, part, parts);
    // `auto` does not guarantee a tool call: retry once before giving up.
    const attempts = this.forced ? 1 : 2;
    for (let attempt = 1; ; attempt += 1) {
      const message = await this.call(client, params);
      const logFields = {
        model: this.model,
        part: part + 1,
        parts,
        attempt,
        stop_reason: message.stop_reason,
        input_tokens: message.usage?.input_tokens ?? null,
        output_tokens: message.usage?.output_tokens ?? null,
      };
      if (message.stop_reason === "refusal") {
        this.log("ai.extract.refused", logFields);
        throw new ModelClientError("refused");
      }
      if (message.stop_reason === "max_tokens") {
        this.log("ai.extract.truncated", logFields);
        throw new ModelClientError("output_truncated");
      }
      if (message.stop_reason === "model_context_window_exceeded") {
        this.log("ai.extract.context_exceeded", logFields);
        throw new ModelClientError("context_exceeded");
      }
      const block = message.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === RECORD_CANDIDATES_TOOL_NAME,
      );
      if (!block) {
        this.log("ai.extract.no_tool_call", logFields);
        if (attempt < attempts) continue;
        throw new ModelClientError("no_tool_call");
      }
      const parsed = ToolInputSchema.safeParse(block.input);
      if (!parsed.success) {
        this.log("ai.extract.invalid_output", { ...logFields, issues: parsed.error.issues.length });
        throw new ModelClientError("invalid_output");
      }
      this.log("ai.extract.chunk", { ...logFields, candidates: parsed.data.candidates.length });
      return parsed.data.candidates;
    }
  }

  private async call(client: MessagesClient, params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    try {
      return await client.messages.create(params);
    } catch (err) {
      const mapped = mapSdkError(err);
      this.log("ai.extract.error", { model: this.model, code: mapped.code, status: mapped.status, request_id: mapped.requestId });
      throw mapped;
    }
  }
}

/** Map SDK errors to coded errors without copying their message (it can echo request content). */
export function mapSdkError(err: unknown): ModelClientError {
  if (err instanceof ModelClientError) return err;
  if (err instanceof Anthropic.APIError) {
    const details = { status: err.status ?? null, requestId: err.requestID ?? null };
    let code: ModelErrorCode;
    if (err instanceof Anthropic.APIUserAbortError) code = "aborted";
    else if (err instanceof Anthropic.APIConnectionTimeoutError) code = "timeout";
    else if (err instanceof Anthropic.APIConnectionError) code = "connection_failed";
    else if (err instanceof Anthropic.AuthenticationError) code = "auth_failed";
    else if (err instanceof Anthropic.PermissionDeniedError) code = "permission_denied";
    else if (err instanceof Anthropic.NotFoundError) code = "not_found";
    else if (err instanceof Anthropic.RateLimitError) code = "rate_limited";
    else if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.UnprocessableEntityError) code = "bad_request";
    else if (err.status === 529 || err.type === "overloaded_error") code = "overloaded";
    else if (err instanceof Anthropic.InternalServerError || (err.status ?? 0) >= 500) code = "server_error";
    else if (err.status === 413) code = "bad_request";
    else code = "unknown";
    return new ModelClientError(code, details);
  }
  return new ModelClientError("unknown");
}
