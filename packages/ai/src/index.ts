export const aiPackageName = "@veradact/ai";

export {
  ITEM_KINDS,
  RawCandidateSchema,
  RawCandidateListSchema,
  ModelClientError,
  type ItemKind,
  type SourceType,
  type ExistingItem,
  type ExtractionInput,
  type RawCandidate,
  type ModelClient,
  type ModelErrorCode,
} from "./model-client";
export {
  AnthropicModelClient,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_CHUNK_CHARS,
  RECORD_CANDIDATES_TOOL,
  RECORD_CANDIDATES_TOOL_NAME,
  supportsForcedToolChoice,
  mapSdkError,
  type AnthropicModelClientOptions,
  type MessagesClient,
  type ModelLogFn,
} from "./anthropic-client";
export { RecordedModelClient, RecordedResponseSchema, type Recording, type RecordedResponse } from "./recorded-client";
export { MockModelClient, type MockResponse } from "./mock-client";
export { chunkText, rebaseCandidates, type Chunk } from "./chunk";
export { loadPrompt, parsePromptVersion, type LoadedPrompt } from "./prompts";
export {
  verifyQuote,
  verifyCandidates,
  MAX_QUOTE_CHARS,
  type Verification,
  type QuoteVerification,
  type QuoteDropReason,
  type DropReason,
  type VerifiedCandidate,
  type VerificationCounts,
  type VerificationResult,
} from "./verify";
