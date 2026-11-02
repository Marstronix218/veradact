/**
 * Business days (D-021): Monday–Friday in an IANA time zone, no holidays.
 *
 * `addBusinessDays(t, n, tz)` moves to the n-th weekday after t's local calendar date (a weekend
 * start counts the following Monday as the first business day) and keeps t's local wall time, so
 * the result is DST-correct. A wall time that does not exist on the target day (spring-forward gap)
 * resolves forward (02:30 → 03:30); an ambiguous one (fall-back) resolves as `TZDate` does (the
 * standard-time occurrence).
 */
import { TZDate } from "@date-fns/tz";

interface LocalParts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  ms: number;
}

function localParts(instant: Date, timeZone: string): LocalParts {
  const local = new TZDate(instant.getTime(), timeZone);
  if (Number.isNaN(local.getTime()) || Number.isNaN(local.getFullYear())) {
    throw new RangeError("invalid instant or time zone");
  }
  return {
    y: local.getFullYear(),
    m: local.getMonth(),
    d: local.getDate(),
    h: local.getHours(),
    mi: local.getMinutes(),
    s: local.getSeconds(),
    ms: local.getMilliseconds(),
  };
}

/** Day number (days since 1970-01-01) of a local calendar date; pure calendar arithmetic. */
function dayNumber(y: number, m: number, d: number): number {
  return Math.round(Date.UTC(y, m, d) / 86_400_000);
}

function isWeekdayDayNumber(day: number): boolean {
  const dow = new Date(day * 86_400_000).getUTCDay();
  return dow !== 0 && dow !== 6;
}

export function addBusinessDays(instant: Date, n: number, timeZone: string): Date {
  if (!Number.isInteger(n)) throw new RangeError("n must be an integer");
  const p = localParts(instant, timeZone);
  if (n === 0) return new Date(instant.getTime());
  const step = n > 0 ? 1 : -1;
  let day = dayNumber(p.y, p.m, p.d);
  let remaining = Math.abs(n);
  while (remaining > 0) {
    day += step;
    if (isWeekdayDayNumber(day)) remaining--;
  }
  const target = new Date(day * 86_400_000);
  const result = new TZDate(
    target.getUTCFullYear(),
    target.getUTCMonth(),
    target.getUTCDate(),
    p.h,
    p.mi,
    p.s,
    p.ms,
    timeZone,
  );
  return new Date(result.getTime());
}

/**
 * Business days from `a` to `b` by local calendar date in `timeZone`: the number of weekdays d with
 * date(a) < d <= date(b) (negative when b is before a). Time of day is ignored.
 * `businessDaysBetween(t, addBusinessDays(t, n, tz), tz) === n`.
 */
export function businessDaysBetween(a: Date, b: Date, timeZone: string): number {
  const pa = localParts(a, timeZone);
  const pb = localParts(b, timeZone);
  const da = dayNumber(pa.y, pa.m, pa.d);
  const db = dayNumber(pb.y, pb.m, pb.d);
  const [lo, hi, sign] = da <= db ? [da, db, 1] : [db, da, -1];
  let count = 0;
  for (let day = lo + 1; day <= hi; day++) if (isWeekdayDayNumber(day)) count++;
  return count === 0 ? 0 : sign * count;
}
