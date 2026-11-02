import { describe, expect, it } from "vitest";
import { ValidationError } from "@veradact/core";
import { currentCut, parseAsOf } from "./as-of";

const NY = "America/New_York";

describe("parseAsOf (ARCHITECTURE §1.1)", () => {
  it("reads a date-only value as the end of that day in the engagement time zone", () => {
    expect(parseAsOf("2026-03-05", NY).toISOString()).toBe("2026-03-06T04:59:59.999Z"); // EST, UTC-5
    expect(parseAsOf("2026-07-01", NY).toISOString()).toBe("2026-07-02T03:59:59.999Z"); // EDT, UTC-4
    expect(parseAsOf(" 2026-03-08 ", NY).toISOString()).toBe("2026-03-09T03:59:59.999Z"); // DST starts that day
    expect(parseAsOf("2026-03-05", "Asia/Tokyo").toISOString()).toBe("2026-03-05T14:59:59.999Z");
    expect(parseAsOf("2026-03-05", "UTC").toISOString()).toBe("2026-03-05T23:59:59.999Z");
  });

  it("uses a full ISO timestamp as is (truncated to milliseconds)", () => {
    expect(parseAsOf("2026-03-05T12:00:00Z", NY).toISOString()).toBe("2026-03-05T12:00:00.000Z");
    expect(parseAsOf("2026-03-05T12:00:00+02:00", NY).toISOString()).toBe("2026-03-05T10:00:00.000Z");
    expect(parseAsOf("2026-03-05T12:00Z", NY).toISOString()).toBe("2026-03-05T12:00:00.000Z");
    expect(parseAsOf("2026-03-05T12:00:00.123456Z", NY).toISOString()).toBe("2026-03-05T12:00:00.123Z");
  });

  it.each(["", "yesterday", "2026-02-30", "2026-13-01", "2026-3-5", "2026-03-05T12:00:00", "2026-03-05T25:00:00Z", "2026-02-30T12:00:00Z", "1772712000000"])(
    "rejects %j with a ValidationError on as_of",
    (input) => {
      let error: unknown;
      try {
        parseAsOf(input, NY);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).field).toBe("as_of");
    },
  );
});

describe("currentCut", () => {
  const now = new Date("2026-03-15T12:00:00.000Z");
  const at = (iso: string) => ({ recordedAt: new Date(iso) });

  it("is the reader's now unless the log was recorded ahead of it", () => {
    expect(currentCut(now, [])).toBe(now);
    expect(currentCut(now, [at("2026-03-01T00:00:00.000Z"), at("2026-03-15T11:59:59.999Z")])).toBe(now);
    expect(currentCut(now, [at("2026-03-01T00:00:00.000Z"), at("2026-03-20T15:00:00.000Z")]).toISOString()).toBe("2026-03-20T15:00:00.000Z");
  });
});
