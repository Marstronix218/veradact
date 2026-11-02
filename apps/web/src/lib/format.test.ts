import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime } from "./format";

describe("format", () => {
  const t = new Date("2026-09-08T16:30:00.000Z");

  it("formats dates and times in the engagement's time zone", () => {
    expect(formatDate(t, "America/New_York")).toBe("Sep 8, 2026");
    expect(formatDateTime(t, "America/New_York")).toBe("Sep 8, 2026, 12:30 PM EDT");
  });

  it("falls back to UTC for an unknown zone", () => {
    expect(formatDateTime(t, "Not/AZone")).toBe("Sep 8, 2026, 4:30 PM UTC");
  });
});
