// Value sets enforced by CHECK constraints. Types are derived for column typing.

export const userRoles = ["admin", "member"] as const;
export type UserRole = (typeof userRoles)[number];

export const engagementStatuses = ["active", "archived"] as const;
export type EngagementStatus = (typeof engagementStatuses)[number];

export const actorTypes = ["user", "contact", "system"] as const;
export type ActorType = (typeof actorTypes)[number];

export const sourceTypes = ["human_notes", "machine_transcript", "email", "chat_export"] as const;
export type SourceType = (typeof sourceTypes)[number];

export const sourceFormats = ["txt", "md", "vtt", "srt", "docx", "paste"] as const;
export type SourceFormat = (typeof sourceFormats)[number];

export const redactionReasonCodes = [
  "user_request",
  "retention",
  "consent_withdrawn",
  "uploaded_in_error",
  "other",
] as const;
export type RedactionReasonCode = (typeof redactionReasonCodes)[number];

export const itemKinds = ["problem", "constraint", "assumption", "decision", "requirement"] as const;
export type ItemKind = (typeof itemKinds)[number];

export const itemStatuses = ["pending", "confirmed", "disputed"] as const;
export type ItemStatus = (typeof itemStatuses)[number];

export const itemLifecycles = ["active", "superseded", "withdrawn"] as const;
export type ItemLifecycle = (typeof itemLifecycles)[number];

export const revisionReasonCodes = [
  "client_dispute",
  "new_information",
  "correction",
  "scope_change",
  "other",
] as const;
export type RevisionReasonCode = (typeof revisionReasonCodes)[number];

export const clientResponses = ["confirmed", "disputed"] as const;
export type ClientResponse = (typeof clientResponses)[number];

export const authorizationDecisions = ["granted", "declined"] as const;
export type AuthorizationDecision = (typeof authorizationDecisions)[number];

export const extractionRunStatuses = ["running", "succeeded", "failed", "discarded"] as const;
export type ExtractionRunStatus = (typeof extractionRunStatuses)[number];

export const candidateVerifications = ["exact", "offset_corrected"] as const;
export type CandidateVerification = (typeof candidateVerifications)[number];

export const candidateStatuses = ["pending", "accepted", "rejected"] as const;
export type CandidateStatus = (typeof candidateStatuses)[number];

export const notificationKinds = ["item_disputed", "authorization_declined"] as const;
export type NotificationKind = (typeof notificationKinds)[number];

export const usageEventKinds = [
  "spec_export",
  "record_export_md",
  "record_export_pdf",
  "mcp_fetch",
] as const;
export type UsageEventKind = (typeof usageEventKinds)[number];

/** Default all-party-consent jurisdictions (ARCHITECTURE §9.2). */
export const DEFAULT_ALL_PARTY_STATES = [
  "CA",
  "CT",
  "DE",
  "FL",
  "IL",
  "MD",
  "MA",
  "MT",
  "NV",
  "NH",
  "OR",
  "PA",
  "WA",
] as const;
