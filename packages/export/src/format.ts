/** Date formatting and display labels shared by every export. Deterministic for a given input. */
import type { ChainFailureReason, Kind, ReviewCause, SourceType } from "@veradact/core";

const formatters = new Map<string, Intl.DateTimeFormat>();

function makeFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  });
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = makeFormatter(timeZone);
    } catch {
      // An unknown zone must not break an export; fall back to UTC.
      f = makeFormatter("UTC");
    }
    formatters.set(timeZone, f);
  }
  return f;
}

function localParts(d: Date, timeZone: string): { date: string; time: string; offset: string } {
  const p: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of formatterFor(timeZone).formatToParts(d)) p[part.type] = part.value;
  // ICU versions differ ("GMT" vs "GMT+00:00", "-" vs U+2212); normalize to "UTC" / "UTC-05:00".
  const offset = (p.timeZoneName ?? "GMT").replace(/−/g, "-").replace(/^GMT/, "UTC").replace(/^UTC[+-]00:00$/, "UTC");
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, offset };
}

/** `2026-03-04` in `timeZone`. */
export function formatDate(d: Date, timeZone: string): string {
  return localParts(d, timeZone).date;
}

/** `2026-03-04 10:15 UTC-05:00` in `timeZone`. */
export function formatDateTime(d: Date, timeZone: string): string {
  const { date, time, offset } = localParts(d, timeZone);
  return `${date} ${time} ${offset}`;
}

/** Exact UTC timestamp, the form that is hashed (`Date.toISOString()`). */
export function isoUtc(d: Date): string {
  return d.toISOString();
}

export const KIND_SECTION: Readonly<Record<Kind, string>> = {
  problem: "Problems",
  constraint: "Constraints",
  assumption: "Assumptions",
  decision: "Decisions",
  requirement: "Requirements",
};

export const SOURCE_TYPE_LABEL: Readonly<Record<SourceType, string>> = {
  human_notes: "Human notes",
  machine_transcript: "Machine transcript",
  email: "Email",
  chat_export: "Chat export",
};

export const REVIEW_CAUSE_TEXT: Readonly<Record<ReviewCause, string>> = {
  revised: "was revised",
  superseded: "was superseded",
  withdrawn: "was withdrawn",
  disputed: "was disputed by the client",
};

export const CHAIN_FAILURE_TEXT: Readonly<Record<ChainFailureReason, string>> = {
  seq_gap: "sequence gap: an event is missing, duplicated or out of order",
  prev_hash_mismatch: "broken link: the event's prev_hash does not equal the previous event's hash",
  hash_mismatch: "content changed: the recomputed hash does not equal the stored hash",
  truncated: "truncated or rewritten: the log is shorter than, or diverges from, the expected head",
};
