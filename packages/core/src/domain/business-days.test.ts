import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addBusinessDays, businessDaysBetween } from "./business-days";

const NY = "America/New_York";
const d = (iso: string) => new Date(iso);

describe("addBusinessDays", () => {
  it("skips the weekend and keeps wall time across the US fall-back (2026-11-01)", () => {
    // Friday 10:00 EDT → Monday 10:00 EST.
    expect(addBusinessDays(d("2026-10-30T14:00:00.000Z"), 1, NY)).toEqual(d("2026-11-02T15:00:00.000Z"));
    expect(addBusinessDays(d("2026-10-30T14:00:00.000Z"), 2, NY)).toEqual(d("2026-11-03T15:00:00.000Z"));
  });

  it("keeps wall time across the US spring-forward (2026-03-08)", () => {
    // Friday 09:00 EST → Monday 09:00 EDT.
    expect(addBusinessDays(d("2026-03-06T14:00:00.000Z"), 1, NY)).toEqual(d("2026-03-09T13:00:00.000Z"));
  });

  it("keeps wall time across the EU change (2026-10-25) in Europe/Berlin", () => {
    // Friday 2026-10-23 17:30 CEST → Tuesday 2026-10-27 17:30 CET.
    expect(addBusinessDays(d("2026-10-23T15:30:00.000Z"), 2, "Europe/Berlin")).toEqual(d("2026-10-27T16:30:00.000Z"));
  });

  it("uses the local date, not the UTC date", () => {
    // Friday 22:00 in New York is already Saturday in UTC.
    expect(addBusinessDays(d("2026-03-14T02:00:00.000Z"), 1, NY)).toEqual(d("2026-03-17T02:00:00.000Z"));
    // Same instant in Tokyo is Saturday 11:00 → Monday 11:00 JST.
    expect(addBusinessDays(d("2026-03-14T02:00:00.000Z"), 1, "Asia/Tokyo")).toEqual(d("2026-03-16T02:00:00.000Z"));
  });

  it("counts Monday as the first business day after a weekend start", () => {
    // Saturday 10:00 and Sunday 10:00 EDT + 1 → Monday 10:00; + 2 → Tuesday 10:00.
    expect(addBusinessDays(d("2026-06-13T14:00:00.000Z"), 1, NY)).toEqual(d("2026-06-15T14:00:00.000Z"));
    expect(addBusinessDays(d("2026-06-14T14:00:00.000Z"), 2, NY)).toEqual(d("2026-06-16T14:00:00.000Z"));
  });

  it("handles zero, negative and multi-week offsets", () => {
    const wed = d("2026-06-10T14:00:00.000Z");
    expect(addBusinessDays(wed, 0, NY)).toEqual(wed);
    expect(addBusinessDays(wed, 5, NY)).toEqual(d("2026-06-17T14:00:00.000Z"));
    expect(addBusinessDays(wed, 10, NY)).toEqual(d("2026-06-24T14:00:00.000Z"));
    expect(addBusinessDays(wed, -3, NY)).toEqual(d("2026-06-05T14:00:00.000Z"));
  });

  it("resolves a wall time missing on the target day forward", () => {
    // Africa/Cairo springs forward on Friday 2026-04-24 at 00:00 (00:00 → 01:00), a weekday gap.
    // Thursday 00:30 EET + 1 → Friday 00:30 does not exist → Friday 01:30 EEST.
    const thu = d("2026-04-22T22:30:00.000Z");
    expect(addBusinessDays(thu, 1, "Africa/Cairo")).toEqual(d("2026-04-23T22:30:00.000Z"));
  });

  it("rejects invalid input", () => {
    expect(() => addBusinessDays(d("2026-06-10T14:00:00.000Z"), 1.5, NY)).toThrow(RangeError);
    expect(() => addBusinessDays(d("2026-06-10T14:00:00.000Z"), 1, "Not/AZone")).toThrow(RangeError);
    expect(() => addBusinessDays(new Date(Number.NaN), 1, NY)).toThrow(RangeError);
  });

  it("round-trips with businessDaysBetween and keeps local wall time (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2024, 0, 1), max: Date.UTC(2028, 0, 1) }),
        fc.integer({ min: 0, max: 30 }),
        fc.constantFrom(NY, "Europe/Berlin", "Asia/Tokyo", "Australia/Sydney", "UTC"),
        (ms, n, tz) => {
          const t = new Date(ms);
          const r = addBusinessDays(t, n, tz);
          const local = (x: Date) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(x);
          expect(r.getTime()).toBeGreaterThanOrEqual(t.getTime());
          if (n > 0) expect(["Sat", "Sun"].some((w) => local(r).startsWith(w))).toBe(false);
          expect(businessDaysBetween(t, r, tz)).toBe(n);
          expect(businessDaysBetween(r, t, tz)).toBe(n === 0 ? 0 : -n);
          // Same wall-clock minute unless the target day has a DST gap at that time.
          const time = (x: Date) => local(x).slice(-5);
          if (time(r) !== time(t)) expect(Math.abs(r.getTime() - t.getTime()) % 86_400_000).not.toBe(0);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("businessDaysBetween", () => {
  it("counts weekdays after the start date up to and including the end date", () => {
    expect(businessDaysBetween(d("2026-06-12T14:00:00.000Z"), d("2026-06-15T13:00:00.000Z"), NY)).toBe(1);
    expect(businessDaysBetween(d("2026-06-13T14:00:00.000Z"), d("2026-06-14T14:00:00.000Z"), NY)).toBe(0);
    expect(businessDaysBetween(d("2026-06-10T14:00:00.000Z"), d("2026-06-10T20:00:00.000Z"), NY)).toBe(0);
    expect(businessDaysBetween(d("2026-06-14T14:00:00.000Z"), d("2026-06-13T14:00:00.000Z"), NY)).toBe(0);
    expect(businessDaysBetween(d("2026-06-15T14:00:00.000Z"), d("2026-06-12T14:00:00.000Z"), NY)).toBe(-1);
  });
});
