// Coded errors thrown by core services. Messages are fixed, user-presentable strings: they
// never contain names, emails, tokens, source text or query parameters (CLAUDE.md rules).
// Callers branch on `code`; apps map codes to HTTP statuses or form messages.
// Append new error classes at the end of this file.

export class CoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export function isCoreError(error: unknown): error is CoreError {
  return error instanceof CoreError;
}

/** The actor is authenticated but not allowed to do this (e.g. a member editing org settings). */
export class ForbiddenError extends CoreError {
  constructor(message = "You don't have permission to do that.") {
    super("forbidden", message);
  }
}

/** The target does not exist in the caller's tenant (RLS makes other tenants' rows invisible). */
export class NotFoundError extends CoreError {
  constructor(message = "Not found.") {
    super("not_found", message);
  }
}

/** Input failed validation. `field` names the offending input (a code constant, never a value). */
export class ValidationError extends CoreError {
  readonly field: string | undefined;

  constructor(message: string, field?: string) {
    super("invalid_input", message);
    this.field = field;
  }
}

/** The change conflicts with existing state (e.g. a unique email). */
export class ConflictError extends CoreError {
  constructor(message: string) {
    super("conflict", message);
  }
}

export class RateLimitedError extends CoreError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, message = "Too many requests. Try again later.") {
    super("rate_limited", message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// ---------------------------------------------------------------------------------------------
// Ledger (store + commands). Each code has one fixed message; `details` carries ids, enums and
// counts only, never statements, quotes, names or other input values.

export const LEDGER_ERROR_MESSAGES = {
  engagement_not_found: "That engagement does not exist.",
  engagement_exists: "An engagement with that id already exists.",
  invalid_short_code: "Short codes are 2 to 8 characters, A-Z and 0-9.",
  short_code_taken: "Another engagement already uses that short code.",
  short_code_immutable: "An engagement's short code cannot be changed.",
  invalid_time_zone: "That is not a valid IANA time zone.",
  invalid_name: "Enter a name of 1 to 200 characters.",
  nothing_to_update: "Nothing to update.",
  invalid_event: "The change could not be recorded because it is not valid.",
  contact_not_found: "That contact does not exist in this engagement.",
  contact_erased: "That contact has been erased.",
  invalid_email: "Enter a valid email address.",
  source_not_found: "That source does not exist in this engagement.",
  source_redacted: "That source has been redacted.",
  source_empty: "The source has no text.",
  source_not_normalized: "The source text must be normalized before it is ingested.",
  source_integrity_mismatch: "The stored source text does not match its recorded hash.",
  invalid_source_date: "Enter a valid source date.",
  consent_blocked: "This source cannot be added without consent from every participant.",
  item_not_found: "That item does not exist in this engagement.",
  item_exists: "An item with that id already exists.",
  item_not_active: "That item has been superseded or withdrawn.",
  invalid_statement: "Statements are 1 to 2000 characters and cannot be blank.",
  sourced_or_manual: "An item version must cite at least one source quote or be marked as entered manually, not both.",
  quote_not_found: "That quote does not appear in the source.",
  quote_ambiguous: "That quote appears more than once in the source. Use a longer quote.",
  quote_mismatch: "The quote does not match the source text at the given position.",
  span_out_of_range: "The quoted range is outside the source text.",
  span_not_on_item: "That quote is not cited by the current version of the item.",
  dependency_kind_not_allowed: "Only decisions and requirements can depend on other items.",
  dependency_target_invalid: "An item can only depend on another active item.",
  dependency_exists: "That dependency already exists.",
  dependency_not_found: "That dependency does not exist.",
  dependency_cycle: "That dependency would create a cycle.",
  review_not_needed: "That item does not need review.",
  supersede_target_invalid: "An item can only be superseded by another active item.",
  item_not_requestable: "Only active items that are pending or disputed can be sent for confirmation.",
  version_mismatch: "The item has changed since this version. Review the current version.",
  invalid_expiry: "The expiry must be in the future.",
  request_not_found: "That confirmation request does not exist.",
  request_revoked: "That confirmation request has been revoked.",
  request_expired: "That confirmation request has expired.",
  contact_not_in_request: "That contact is not part of this confirmation request.",
  not_authorized: "The contact has not granted authorization to record confirmations.",
  item_not_in_request: "That item version is not part of this confirmation request.",
  duplicate_item_response: "Each item can be answered once per submission.",
  empty_submission: "Choose at least one item to confirm or dispute.",
  comment_required: "A comment is required to dispute an item.",
  invalid_comment: "Comments are at most 5000 characters.",
  invalid_note: "Notes are at most 2000 characters.",
  invalid_authorization_text: "The authorization text is missing or too long.",
} as const;

export type LedgerErrorCode = keyof typeof LEDGER_ERROR_MESSAGES;

export type DomainErrorDetails = Readonly<Record<string, string | number | boolean | null | readonly string[]>>;

/**
 * A ledger rule rejected the command (nothing was written). `code` is stable; `details` holds
 * ids, enums, counts or validation paths only.
 */
export class DomainError extends CoreError {
  declare readonly code: LedgerErrorCode;
  readonly details: DomainErrorDetails;

  constructor(code: LedgerErrorCode, details: DomainErrorDetails = {}) {
    super(code, LEDGER_ERROR_MESSAGES[code]);
    this.details = details;
  }
}

export function isDomainError(error: unknown, code?: LedgerErrorCode): error is DomainError {
  return error instanceof DomainError && (code === undefined || error.code === code);
}

/**
 * The consent policy blocked an ingest (ARCHITECTURE §9.2). `explanation` is the user-facing
 * text from `evaluateConsent` (names the states and how to proceed); show it to the uploader.
 */
export class ConsentBlockedError extends DomainError {
  readonly rule: "all_party_state_without_consent" | "unknown_jurisdiction_without_consent";
  readonly blockingStates: readonly string[];
  readonly explanation: string;

  constructor(result: {
    rule: "all_party_state_without_consent" | "unknown_jurisdiction_without_consent";
    blockingStates: readonly string[];
    explanation: string;
  }) {
    super("consent_blocked", { rule: result.rule, blockingStates: [...result.blockingStates] });
    this.rule = result.rule;
    this.blockingStates = [...result.blockingStates];
    this.explanation = result.explanation;
  }
}

// ---------------------------------------------------------------------------------------------
// AI extraction and the review queue (ARCHITECTURE §9.3, §9.4).

/**
 * AI is switched off for the org or the engagement (CLAUDE.md invariant 9). Thrown by
 * `runExtraction` inside the tenant transaction before any model client is constructed.
 */
export class AiDisabledError extends CoreError {
  readonly scope: "org" | "engagement";

  constructor(scope: "org" | "engagement") {
    super(
      "ai_disabled",
      scope === "org"
        ? "AI suggestions are turned off for your organization. No source text was sent to any model provider."
        : "AI suggestions are turned off for this engagement. No source text was sent to any model provider.",
    );
    this.scope = scope;
  }
}

export const REVIEW_ERROR_MESSAGES = {
  candidate_not_found: "That suggestion does not exist in this engagement.",
  candidate_decided: "That suggestion has already been accepted or rejected.",
  revision_kind_immutable: "A revision keeps the kind of the item it revises.",
} as const;

export type ReviewErrorCode = keyof typeof REVIEW_ERROR_MESSAGES;

/** A review-queue action was rejected (nothing was written). */
export class ReviewError extends CoreError {
  declare readonly code: ReviewErrorCode;

  constructor(code: ReviewErrorCode) {
    super(code, REVIEW_ERROR_MESSAGES[code]);
  }
}
