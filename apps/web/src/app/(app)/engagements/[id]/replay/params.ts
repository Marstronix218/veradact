// Query parameters of the replay screen. Every view is a GET URL, so it can be linked and reloaded.
//
//   ?as_of=2026-03-05&view=known&kind=decision&status=pending   known view at the end of Mar 5 (engagement zone)
//   ?as_of=2026-03-05&view=agreed                               agreed view (D-010)
//   ?view=compare&from=2026-03-01&to=2026-03-08                 diff between the ends of two days
//   ?decision=HALV-D1&version=2                                 decision context of D1 v2
import { ValidationError, type ItemStatus, type Kind } from "@veradact/core";
import { parseAsOf } from "@veradact/export/server";
import { localDateString } from "@/lib/dates";
import { enumValue, KIND_LABELS, STATUS_LABELS } from "@/lib/labels";

export type ReplayTab = "known" | "agreed" | "compare";

export interface ReplaySearch {
  as_of?: string;
  view?: string;
  kind?: string;
  status?: string;
  from?: string;
  to?: string;
  decision?: string;
  version?: string;
}

export interface ResolvedInstant {
  /** The value from the URL, trimmed ("" when absent). */
  input: string;
  /** The instant replayed: `parseAsOf(input)` (a date means the end of that day), else the fallback. */
  at: Date;
  /** The input was a date only, read as 23:59:59.999 of that day in the engagement time zone. */
  endOfDay: boolean;
  /** `YYYY-MM-DD` of `at` in the engagement time zone, for date inputs. */
  date: string;
  /** Why the input was rejected (the fallback is used instead). */
  error: string | null;
}

export interface ReplayParams {
  tab: ReplayTab;
  asOf: ResolvedInstant;
  kind: Kind | undefined;
  status: ItemStatus | undefined;
  from: ResolvedInstant;
  to: ResolvedInstant;
  decision: { ref: string; version: number | undefined } | null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/**
 * Resolves a user-entered `as_of`-style value (ARCHITECTURE §1.1) or falls back to `fallback`
 * (`fallbackIsEndOfDay` when the fallback is itself the end of a local day).
 */
export function resolveInstant(value: string | undefined, timeZone: string, fallback: Date, fallbackIsEndOfDay = false): ResolvedInstant {
  const input = (value ?? "").trim();
  let at = fallback;
  let error: string | null = null;
  if (input !== "") {
    try {
      at = parseAsOf(input, timeZone);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      error = "Enter a valid date.";
    }
  }
  const endOfDay = input !== "" && error === null ? DATE_ONLY.test(input) : fallbackIsEndOfDay;
  return { input, at, endOfDay, date: localDateString(at, timeZone), error };
}

export function parseReplayParams(search: ReplaySearch, timeZone: string, now: Date): ReplayParams {
  const tab: ReplayTab = search.view === "agreed" || search.view === "compare" ? search.view : "known";
  const to = resolveInstant(search.to, timeZone, now);
  // Default comparison window: the seven days before `to` (end of that local day).
  const from = resolveInstant(search.from, timeZone, parseAsOf(localDateString(new Date(to.at.getTime() - 7 * DAY_MS), timeZone), timeZone), true);
  const ref = (search.decision ?? "").trim();
  const version = /^[1-9]\d{0,8}$/.test((search.version ?? "").trim()) ? Number(search.version) : undefined;
  return {
    tab,
    asOf: resolveInstant(search.as_of, timeZone, now),
    kind: enumValue<Kind>(KIND_LABELS, search.kind),
    status: enumValue<ItemStatus>(STATUS_LABELS, search.status),
    from,
    to,
    decision: ref === "" ? null : { ref, version },
  };
}

/** `${base}/replay?…` with empty values left out. */
export function replayHref(base: string, query: Record<string, string | number | undefined | null>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  const qs = params.toString();
  return `${base}/replay${qs ? `?${qs}` : ""}`;
}
