// Display labels and badge tones for ledger enums (shared by the engagement pages).
import type {
  ItemLifecycle,
  ItemStatus,
  Kind,
  ReviseReason,
  SourceRedactionReason,
  SourceType,
  SupersedeReason,
  WithdrawReason,
} from "@veradact/core";
import type { BadgeTone } from "@/components";

export const KIND_LABELS: Record<Kind, string> = {
  problem: "Problem",
  constraint: "Constraint",
  assumption: "Assumption",
  decision: "Decision",
  requirement: "Requirement",
};

export const STATUS_LABELS: Record<ItemStatus, string> = { pending: "Pending", confirmed: "Confirmed", disputed: "Disputed" };
export const STATUS_TONES: Record<ItemStatus, BadgeTone> = { pending: "yellow", confirmed: "green", disputed: "red" };

export const LIFECYCLE_LABELS: Record<ItemLifecycle, string> = { active: "Active", superseded: "Superseded", withdrawn: "Withdrawn" };

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  human_notes: "Human-written notes",
  machine_transcript: "Machine transcript",
  email: "Email",
  chat_export: "Chat export",
};

export const REVISE_REASON_LABELS: Record<ReviseReason, string> = {
  client_dispute: "Client dispute",
  new_information: "New information",
  correction: "Correction",
  scope_change: "Scope change",
  other: "Other",
};

export const WITHDRAW_REASON_LABELS: Record<WithdrawReason, string> = {
  client_dispute: "Client dispute",
  out_of_scope: "Out of scope",
  duplicate: "Duplicate",
  entered_in_error: "Entered in error",
  other: "Other",
};

export const SUPERSEDE_REASON_LABELS: Record<SupersedeReason, string> = {
  client_dispute: "Client dispute",
  new_information: "New information",
  correction: "Correction",
  scope_change: "Scope change",
  kind_change: "Kind change",
  duplicate: "Duplicate",
  other: "Other",
};

export const REDACTION_REASON_LABELS: Record<SourceRedactionReason, string> = {
  user_request: "User request",
  retention: "Retention",
  consent_withdrawn: "Consent withdrawn",
  uploaded_in_error: "Uploaded in error",
  other: "Other",
};

/** Narrows a form value to one of `labels`' keys, or returns undefined. */
export function enumValue<K extends string>(labels: Record<K, string>, value: FormDataEntryValue | string | null | undefined): K | undefined {
  return typeof value === "string" && Object.hasOwn(labels, value) ? (value as K) : undefined;
}
