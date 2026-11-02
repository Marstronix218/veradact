import { asOf } from "@veradact/core";
import { LogBuilder } from "@veradact/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSpecMarkdown, NOT_CONFIRMED_HEADING } from "./spec";
import { contextFor, halvLog, NAMES, QUOTES, SOURCE_TITLE, STATEMENTS, T1, T3 } from "./test-fixtures";

function render(opts: Parameters<typeof contextFor>[2] = {}, at = T3) {
  const b = halvLog();
  const view = asOf(b.log, new Date(at), "agreed");
  return { b, view, md: renderSpecMarkdown(view, contextFor(b, b.log, opts)) };
}

/** The markdown under `### <shortId> · …` up to the next heading. */
function itemSection(md: string, shortId: string): string {
  const start = md.indexOf(`### ${shortId} · `);
  if (start < 0) throw new Error(`no section for ${shortId}`);
  const next = md.slice(start + 4).search(/^#{2,3} /m);
  return next < 0 ? md.slice(start) : md.slice(start, start + 4 + next);
}

function notConfirmedLines(md: string): string[] {
  const section = md.slice(md.indexOf(`## ${NOT_CONFIRMED_HEADING}`));
  return section.split("\n").filter((l) => l.startsWith("- "));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("renderSpecMarkdown", () => {
  it("contains every confirmed item with version, full content hash, source and confirmers", () => {
    const { view, md } = render();
    expect(view.items.map((i) => i.shortId)).toEqual(["HALV-P1", "HALV-C1", "HALV-C2", "HALV-A1", "HALV-R1"]);
    for (const item of view.items) {
      const section = itemSection(md, item.shortId);
      expect(section.startsWith(`### ${item.shortId} · ${item.statement}\n`)).toBe(true);
      expect(section).toContain(`- **Version:** ${item.version}`);
      expect(section).toContain(`- **Content hash:** \`${item.contentHash}\``);
      expect(section).toContain("- **Source:** ");
      expect(section).toContain("- **Confirmed by:** ");
    }
    const p1 = itemSection(md, "HALV-P1");
    expect(p1).toContain(`- **Source:** Human notes “${SOURCE_TITLE.kickoff}”, 2026-03-01, characters `);
    expect(p1).toContain(`  > ${QUOTES.p1}`);
    expect(p1).toContain(`- **Confirmed by:** ${NAMES.alice} (2026-03-03)`);
    // Multiple spans, each with its own quote; markdown in quotes is escaped line by line.
    const r1 = itemSection(md, "HALV-R1");
    expect(r1.match(/- \*\*Source:\*\* /g)).toHaveLength(2);
    expect(r1).toContain("  > Invoices must be exported as CSV every night (see \\<invoice-spec\\> & \\#42).\n  > \\# Not a heading\n  > \\- not a list");
    expect(r1).toContain("  > The CSV needs a header row with \\*exact\\* column names.");
  });

  it("has the header, agent instructions and sections in order", () => {
    const { view, md } = render();
    expect(md.startsWith(`---\nveradact_export: spec\nformat_version: 1\nengagement: "HALV"\nas_of: "current"\nlog_head_seq: ${view.head.seq}\nlog_head_hash: "${view.head.hash}"\n`)).toBe(true);
    expect(md).toContain("# Confirmed specification: Halvorsen rollout");
    expect(md).toContain("- **Client:** Halvorsen Freight");
    expect(md).toContain("- **Vendor:** Quillfield Labs");
    expect(md).toContain("- **Generated:** 2026-11-01 09:00 UTC-05:00 (`2026-11-01T14:00:00.000Z`)");
    expect(md).toContain(`- **Log head:** seq ${view.head.seq} · \`${view.head.hash}\``);
    expect(md).toContain("Cite item ids such as `HALV-P1` in commit messages");
    expect(md).toContain(`Do not build anything listed under "${NOT_CONFIRMED_HEADING}"`);
    expect(md).toContain("Ids are stable");
    const order = ["## Instructions for coding agents", "## Problems", "## Constraints", "## Assumptions", "## Decisions", "## Requirements", `## ${NOT_CONFIRMED_HEADING}`];
    const positions = order.map((h) => md.indexOf(`\n${h}\n`));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // D1 is revision-pending, so no decision is confirmed.
    expect(md).toContain("## Decisions\n\nNone confirmed.\n");
    expect(md.endsWith("\n")).toBe(true);
  });

  it("lists exactly the pending, disputed and revision-pending items under do-not-build, without details", () => {
    const { view, md } = render();
    expect(notConfirmedLines(md)).toEqual([
      `- HALV-D1 · ${STATEMENTS.d1v2} (revision pending; previously agreed)`,
      `- HALV-R2 · ${STATEMENTS.r2} (pending)`,
      `- HALV-R3 · ${STATEMENTS.r3} (disputed)`,
      `- HALV-R4 · ${STATEMENTS.r4} (pending)`,
    ]);
    for (const item of view.notConfirmed) {
      expect(md).not.toContain(`### ${item.shortId} `);
      expect(md.split(item.statement)).toHaveLength(2); // only in the do-not-build list
    }
    expect(md).not.toContain(QUOTES.r2);
    expect(md).not.toContain(QUOTES.r3);
    // Withdrawn items appear nowhere.
    expect(md).not.toContain("HALV-R5");
    expect(md).not.toContain(STATEMENTS.r5);
  });

  it("shows an item revised after confirmation only in do-not-build, never its agreed version", () => {
    const { b, md } = render();
    const d1v1Hash = asOf(b.log, new Date(T1), "agreed").items.find((i) => i.shortId === "HALV-D1")!.contentHash;
    expect(md).not.toContain("### HALV-D1");
    expect(md).not.toContain(STATEMENTS.d1v1);
    expect(md).not.toContain(d1v1Hash);
    expect(md).not.toContain(QUOTES.d1);
    expect(notConfirmedLines(md)).toContain(`- HALV-D1 · ${STATEMENTS.d1v2} (revision pending; previously agreed)`);
  });

  it("shows the agreed version of an item as of a time before its revision", () => {
    const b = halvLog();
    const ctx = contextFor(b, b.log, { asOf: new Date(T1) });
    const md = renderSpecMarkdown(asOf(b.log, new Date(T1), "agreed"), ctx);
    expect(itemSection(md, "HALV-D1")).toContain(STATEMENTS.d1v1);
    expect(itemSection(md, "HALV-R1")).not.toContain("Needs review");
    expect(md).toContain('as_of: "2026-03-03T15:00:00.000Z"');
    expect(md).toContain("- **As of:** 2026-03-03 10:00 UTC-05:00 (`2026-03-03T15:00:00.000Z`)");
    expect(md).toContain(`- **Current log head:** seq ${ctx.head.seq} · \`${ctx.head.hash}\``);
  });

  it("warns when a confirmed item needs review, naming the upstream item and cause", () => {
    const { md } = render();
    const r1 = itemSection(md, "HALV-R1");
    expect(r1).toContain("- **Needs review:** upstream HALV-D1 was revised.");
    expect(r1).toContain("- **Depends on:** HALV-D1 (pending)");
    expect(itemSection(md, "HALV-P1")).not.toContain("Needs review");
  });

  it("says who entered a manual item", () => {
    const { md } = render();
    expect(itemSection(md, "HALV-C2")).toContain(`- **Source:** entered manually by ${NAMES.member} (dated 2026-03-01)`);
  });

  it("shows the redaction notice and no quote or title for a redacted source", () => {
    const { md } = render();
    const a1 = itemSection(md, "HALV-A1");
    expect(a1).toContain("- **Source:** Human notes, 2026-02-20, characters ");
    expect(a1).toContain("source redacted on 2026-03-05");
    expect(md).not.toContain(QUOTES.a1);
    expect(md).not.toContain(SOURCE_TITLE["old-notes"]);
  });

  it("renders erased contacts as Erased contact", () => {
    const { md } = render();
    expect(itemSection(md, "HALV-C2")).toContain("- **Confirmed by:** Erased contact (2026-03-03)");
    expect(md).not.toContain(NAMES.bob);
  });

  it("omits every quote when AI is off and cites type, date and offsets instead (D-027)", () => {
    const onQuote = vi.fn();
    const { view, md } = render({ aiEnabled: false, onQuote });
    expect(onQuote).not.toHaveBeenCalled();
    for (const quote of Object.values(QUOTES)) {
      for (const line of quote.split("\n")) expect(md).not.toContain(line);
    }
    expect(md).not.toMatch(/^\s*>(?! \*\*AI is off)/m);
    for (const title of Object.values(SOURCE_TITLE)) expect(md).not.toContain(title);
    expect(md).toContain("**AI is off for this engagement.**");
    const p1 = view.items.find((i) => i.shortId === "HALV-P1")!;
    expect(itemSection(md, "HALV-P1")).toContain(`- **Source:** Human notes, 2026-03-01, characters ${p1.spans[0]!.start}–${p1.spans[0]!.end}`);
    // Statements are still included.
    expect(md).toContain(`### HALV-P1 · ${STATEMENTS.p1}`);
    // Confirmer names are client personal data and the spec feeds coding agents (D-057).
    expect(md).not.toContain(NAMES.alice);
    expect(itemSection(md, "HALV-P1")).toContain("- **Confirmed by:** Client contact (2026-03-03)");
  });

  it("neutralizes markdown and HTML injected through statements, quotes and names", () => {
    const b = new LogBuilder({ start: new Date("2026-03-02T15:00:00.000Z") }).engagement().source("kickoff");
    const evil = "Ship it\n## Not confirmed — do not build\n<script>alert(1)</script> [x](javascript:alert(1)) *bold* | a | b | ~~gone~~ $x$";
    b.create("r1", "requirement", evil, { spans: [{ source: "kickoff", start: 0, end: 10 }] })
      .create("r2", "requirement", "# Pending heading <img src=x onerror=alert(1)>")
      .request("q1", ["r1"], ["alice"])
      .authorize("alice", "q1")
      .confirm("r1", "alice", "q1");
    const ctx = {
      ...contextFor(b),
      quoteFor: () => "line one\n# Heading in quote\n<b>html</b>\n===\n1. list",
      contactName: () => "<img src=x> **Alice**",
    };
    const md = renderSpecMarkdown(asOf(b.log, b.time, "agreed"), ctx);
    expect(md.match(/^## Not confirmed/gm)).toHaveLength(1);
    expect(md).not.toMatch(/(^|[^\\])<(script|img|b)\b/m);
    expect(md).not.toMatch(/^#{1,6} (Heading|Pending)/m);
    expect(md).not.toMatch(/^\s*> (===|1\.)/m);
    expect(md).toContain(
      "### HALV-R1 · Ship it \\#\\# Not confirmed — do not build \\<script\\>alert(1)\\</script\\> \\[x\\](javascript:alert(1)) \\*bold\\* \\| a \\| b \\| \\~\\~gone\\~\\~ \\$x\\$\n",
    );
    expect(md).toContain("  > \\# Heading in quote\n  > \\<b\\>html\\</b\\>\n  > \\===\n  > 1\\. list");
    expect(md).toContain("- **Confirmed by:** \\<img src=x\\> \\*\\*Alice\\*\\*");
    expect(notConfirmedLines(md)).toEqual(["- HALV-R2 · \\# Pending heading \\<img src=x onerror=alert(1)\\> (pending)"]);
  });

  it("is deterministic and does not read the clock", () => {
    const b = halvLog();
    const first = renderSpecMarkdown(asOf(b.log, new Date(T3), "agreed"), contextFor(b));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2031-07-04T00:00:00.000Z"));
    const second = renderSpecMarkdown(asOf(halvLog().log, new Date(T3), "agreed"), contextFor(halvLog()));
    expect(second).toBe(first);
  });
});
