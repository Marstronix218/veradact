import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime } from "./format";
import { mdBlockquote, mdCode, mdInline } from "./markdown";

describe("mdInline", () => {
  it("collapses whitespace and escapes characters that open markdown or HTML", () => {
    expect(mdInline("  # Title\n\n<b>x</b> *a* _b_ `c` [d](e) | ~f~ $g$ \\ ")).toBe(
      "\\# Title \\<b\\>x\\</b\\> \\*a\\* \\_b\\_ \\`c\\` \\[d\\](e) \\| \\~f\\~ \\$g\\$ \\\\",
    );
    expect(mdInline("Plain text, with punctuation: 3.5 - ok!")).toBe("Plain text, with punctuation: 3.5 - ok!");
  });
});

describe("mdBlockquote", () => {
  it("quotes each line and escapes block markers at line start", () => {
    expect(mdBlockquote("\nfirst\r\n\n- item\n+ plus\n=== \n12. twelve\n> nested\n", "  ")).toBe(
      "  > first\n  >\n  > \\- item\n  > \\+ plus\n  > \\===\n  > 12\\. twelve\n  > \\> nested",
    );
  });
});

describe("mdCode", () => {
  it("wraps a value in a code span without backticks inside", () => {
    expect(mdCode("ab`c")).toBe("`abc`");
  });
});

describe("date formatting", () => {
  it("formats in the engagement time zone with an explicit offset", () => {
    const t = new Date("2026-07-01T03:30:00.000Z");
    expect(formatDate(t, "America/New_York")).toBe("2026-06-30");
    expect(formatDateTime(t, "America/New_York")).toBe("2026-06-30 23:30 UTC-04:00");
    expect(formatDateTime(t, "Asia/Kolkata")).toBe("2026-07-01 09:00 UTC+05:30");
    expect(formatDateTime(t, "UTC")).toBe("2026-07-01 03:30 UTC");
    expect(formatDateTime(new Date("2026-07-01T00:00:00.000Z"), "UTC")).toBe("2026-07-01 00:00 UTC");
  });

  it("falls back to UTC for an unknown zone instead of failing the export", () => {
    expect(formatDateTime(new Date("2026-07-01T03:30:00.000Z"), "Not/AZone")).toBe("2026-07-01 03:30 UTC");
  });
});
