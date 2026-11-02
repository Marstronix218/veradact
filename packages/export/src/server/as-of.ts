// User-entered `as_of` values (ARCHITECTURE §1.1): a date-only value means the END of that day
// (23:59:59.999 local) in the engagement's time zone; a full ISO 8601 timestamp is used as is.
import { TZDate } from "@date-fns/tz";
import { ValidationError } from "@veradact/core";

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/i;

export const AS_OF_FORMAT_MESSAGE =
  "as_of must be a date (YYYY-MM-DD, read as the end of that day in the engagement's time zone) or an ISO 8601 timestamp with a time zone offset (e.g. 2026-03-05T17:00:00Z).";

function isCalendarDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function invalid(): never {
  throw new ValidationError(AS_OF_FORMAT_MESSAGE, "as_of");
}

/** Parses an `as_of` input for an engagement in `timeZone`. Throws `ValidationError` (field `as_of`) when invalid. */
export function parseAsOf(input: string, timeZone: string): Date {
  const value = input.trim();
  const date = DATE_ONLY.exec(value);
  if (date) {
    const [y, m, d] = [Number(date[1]), Number(date[2]), Number(date[3])];
    if (!isCalendarDate(y, m, d)) invalid();
    const end = new TZDate(y, m - 1, d, 23, 59, 59, 999, timeZone);
    const t = end.getTime();
    if (Number.isNaN(t) || end.getFullYear() !== y || end.getMonth() !== m - 1 || end.getDate() !== d) invalid();
    return new Date(t);
  }
  const ts = TIMESTAMP.exec(value);
  if (!ts) invalid();
  const [y, mo, d, h, mi, s, oh, om] = [ts[1], ts[2], ts[3], ts[4], ts[5], ts[6] ?? "0", ts[7] ?? "0", ts[8] ?? "0"].map(Number) as number[];
  if (!isCalendarDate(y!, mo!, d!) || h! > 23 || mi! > 59 || s! > 59 || oh! > 14 || om! > 59) invalid();
  const t = Date.parse(value);
  if (Number.isNaN(t)) invalid();
  return new Date(Math.trunc(t));
}

/**
 * The replay cut for "now" (no `as_of` given): the later of the reader's clock and the last recorded
 * event. `recorded_at = max(clock(), head.recorded_at)`, so a writer's events can carry times ahead
 * of this reader's clock; cutting at the reader's `now` would hide them (a just-revised confirmed
 * item would still look confirmed and miss the do-not-build list). Pass the events in seq order.
 */
export function currentCut(now: Date, events: readonly { recordedAt: Date }[]): Date {
  const last = events.length > 0 ? events[events.length - 1]!.recordedAt : null;
  return last !== null && last.getTime() > now.getTime() ? last : now;
}
