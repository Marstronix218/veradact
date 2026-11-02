import { describe, expect, it } from "vitest";
import { localDateString, parseLocalDate } from "./dates";

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
