import { asOf } from "@veradact/core";
import { describe, expect, it } from "vitest";
import { renderSpecMarkdown, specFilename } from "./spec";
import { exportTargets, getExportTarget, markdownSpecTarget } from "./target";
import { contextFor, halvLog, T3 } from "./test-fixtures";

describe("export targets", () => {
  it("registers the markdown spec target", () => {
    expect(exportTargets.map((t) => t.id)).toEqual(["markdown-spec"]);
    expect(getExportTarget("markdown-spec")).toBe(markdownSpecTarget);
    expect(getExportTarget("kiro")).toBeUndefined();
  });

  it("renders the spec with a dated filename", () => {
    const b = halvLog();
    const view = asOf(b.log, new Date(T3), "agreed");
    const ctx = contextFor(b);
    const artifact = markdownSpecTarget.render(view, ctx);
    expect(artifact).toEqual({ filename: "HALV-spec-2026-11-01.md", contentType: "text/markdown; charset=utf-8", body: renderSpecMarkdown(view, ctx) });
  });

  it("dates the filename by the as-of day in the engagement time zone", () => {
    const ctx = contextFor(halvLog());
    // 23:59:59.999 on Oct 1 in New York is already Oct 2 in UTC.
    expect(specFilename({ ...ctx, asOf: new Date("2026-10-02T03:59:59.999Z") })).toBe("HALV-spec-2026-10-01.md");
    expect(specFilename({ ...ctx, asOf: null, generatedAt: new Date("2026-10-02T03:59:59.999Z") })).toBe("HALV-spec-2026-10-01.md");
  });
});
