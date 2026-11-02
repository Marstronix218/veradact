import { describe, expect, it } from "vitest";
import { isAfterLocalToday, localDateString, parseLocalDate } from "./dates";

describe("parseLocalDate", () => {
  it("reads a date as the start of that day in the time zone", () => {
    expect(parseLocalDate("2026-09-08", "America/New_York").toISOString()).toBe("2026-09-08T04:00:00.000Z");
    expect(parseLocalDate(" 2026-01-15 ", "Europe/Berlin").toISOString()).toBe("2026-01-14T23:00:00.000Z");
    expect(parseLocalDate("2026-03-08", "UTC").toISOString()).toBe("2026-03-08T00:00:00.000Z");
  });

  it("rejects malformed and impossible dates", () => {
    for (const bad of ["", "2026-9-8", "2026-02-30", "08/09/2026", "2026-09-08T10:00:00Z"]) {
      expect(() => parseLocalDate(bad, "UTC")).toThrow("Enter a valid date.");
    }
  });
});

describe("localDateString", () => {
  it("formats the local calendar date", () => {
    expect(localDateString(new Date("2026-09-08T02:00:00.000Z"), "America/New_York")).toBe("2026-09-07");
    expect(localDateString(new Date("2026-09-08T02:00:00.000Z"), "Asia/Tokyo")).toBe("2026-09-08");
  });
});

describe("isAfterLocalToday", () => {
  it("does not call the end of today the future, in the engagement time zone", () => {
    // 10:00 in New York. A replay date means 23:59:59.999 of that day there (parseAsOf).
    const now = new Date("2026-09-08T14:00:00.000Z");
    expect(isAfterLocalToday(new Date("2026-09-09T03:59:59.999Z"), now, "America/New_York")).toBe(false); // end of Sep 8 (today)
    expect(isAfterLocalToday(new Date("2026-09-08T03:59:59.999Z"), now, "America/New_York")).toBe(false); // end of Sep 7
    expect(isAfterLocalToday(new Date("2026-09-10T03:59:59.999Z"), now, "America/New_York")).toBe(true); // end of Sep 9
    // The first instant of tomorrow is the future.
    expect(isAfterLocalToday(new Date("2026-09-09T04:00:00.000Z"), now, "America/New_York")).toBe(true);
  });

  it("compares calendar days in the given zone, not in UTC", () => {
    // 23:30 UTC on Sep 8 is already Sep 9 in Tokyo: the end of Sep 9 is today there, Sep 10 the future.
    const now = new Date("2026-09-08T23:30:00.000Z");
    expect(isAfterLocalToday(new Date("2026-09-09T14:59:59.999Z"), now, "Asia/Tokyo")).toBe(false);
    expect(isAfterLocalToday(new Date("2026-09-10T14:59:59.999Z"), now, "Asia/Tokyo")).toBe(true);
    expect(isAfterLocalToday(new Date("2026-09-09T14:59:59.999Z"), now, "UTC")).toBe(true);
    // Across a year boundary.
    expect(isAfterLocalToday(new Date("2027-01-01T00:00:00.000Z"), new Date("2026-12-31T23:59:59.000Z"), "UTC")).toBe(true);
  });
});
