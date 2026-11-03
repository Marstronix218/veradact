import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, shortHash } from "./format";

describe("format", () => {
  const t = new Date("2026-09-08T16:30:00.000Z");

  it("formats dates and times in the engagement's time zone", () => {
    expect(formatDate(t, "America/New_York")).toBe("Sep 8, 2026");
    expect(formatDateTime(t, "America/New_York")).toBe("Sep 8, 2026, 12:30 PM EDT");
  });

  it("falls back to UTC for an unknown zone", () => {
    expect(formatDateTime(t, "Not/AZone")).toBe("Sep 8, 2026, 4:30 PM UTC");
  });

  it("shortens a hash to its first 8 and last 6 characters", () => {
    expect(shortHash("cf3b566912dbba39843581d3381aa86d92ec55e01b4f6dc63a0e3a94b2c8cdd7")).toBe("cf3b5669…c8cdd7");
    expect(shortHash("0123456789abcdef")).toBe("0123456789abcdef");
  });
});
