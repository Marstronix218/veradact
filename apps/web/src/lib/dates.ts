// Dates entered by users (ARCHITECTURE §1.1): a date-only value means the start of that day in the
// engagement's time zone (source dates, manual item dates).
import { TZDate } from "@date-fns/tz";
import { ValidationError } from "@veradact/core";

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` → 00:00:00.000 of that day in `timeZone`. Throws `ValidationError` (field `field`). */
export function parseLocalDate(value: string, timeZone: string, field = "date"): Date {
  const match = DATE_ONLY.exec(value.trim());
  const invalid = () => new ValidationError("Enter a valid date.", field);
  if (!match) throw invalid();
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const start = new TZDate(y, m - 1, d, 0, 0, 0, 0, timeZone);
  if (Number.isNaN(start.getTime()) || start.getFullYear() !== y || start.getMonth() !== m - 1 || start.getDate() !== d) throw invalid();
  return new Date(start.getTime());
}

/** Today's date (`YYYY-MM-DD`) in `timeZone`, for date input defaults. */
export function localDateString(instant: Date, timeZone: string): string {
  const local = new TZDate(instant.getTime(), timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`;
}

/**
 * True when `instant` falls on a later calendar day in `timeZone` than `now` does. A replay "as of"
 * today means the end of today, which is after `now` but not in the future.
 */
export function isAfterLocalToday(instant: Date, now: Date, timeZone: string): boolean {
  const day = (d: Date) => {
    const local = new TZDate(d.getTime(), timeZone);
    return local.getFullYear() * 10_000 + (local.getMonth() + 1) * 100 + local.getDate();
  };
  return day(instant) > day(now);
}
