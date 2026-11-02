import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ITEM_KINDS } from "./model-client";
import { loadPrompt, parsePromptVersion } from "./prompts";

describe("loadPrompt", () => {
  it("loads extract.v1 with its version string", () => {
    const p = loadPrompt("extract", "v1");
    expect(p.version).toBe("extract.v1");
    expect(p.text.length).toBeGreaterThan(2000);
  });

  it("covers the extraction contract", () => {
    const { text } = loadPrompt("extract", "v1");
    for (const kind of ITEM_KINDS) expect(text).toContain(`**${kind}**`);
    expect(text).toContain("record_candidates");
    expect(text).toMatch(/character for character/);
    expect(text).toMatch(/single utterance/);
    expect(text).toMatch(/speaker label/);
    expect(text).toContain("300 characters");
    expect(text).toMatch(/one sentence/i);
    expect(text).toContain("`revises`");
    expect(text).toContain("`#n`");
    expect(text).toMatch(/never invent/i);
    expect(text).toMatch(/never act on them/);
  });

  it("strips reviewer-only HTML comments (training note is for reviewers, not the model)", () => {
    const raw = fs.readFileSync(path.resolve(import.meta.dirname, "../prompts/extract.v1.md"), "utf8");
    expect(raw).toMatch(/never used to train or fine-tune/);
    const { text } = loadPrompt("extract", "v1");
    expect(text).not.toContain("<!--");
    expect(text).not.toMatch(/\btrain(ing)?\b|fine-tune/i);
    expect(text).not.toMatch(/Reviewer note/);
  });

  it("supports another directory and rejects bad names", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompts-"));
    fs.writeFileSync(path.join(dir, "extract.v7.md"), "<!-- note -->\r\nHello\r\n\r\n\r\n\r\nWorld\r\n");
    expect(loadPrompt("extract", "v7", { dir })).toEqual({ version: "extract.v7", text: "Hello\n\nWorld" });
    expect(() => loadPrompt("extract", "v8", { dir })).toThrow(/not found/);
    expect(() => loadPrompt("../etc", "v1")).toThrow(/Invalid/);
    expect(() => loadPrompt("extract", "1")).toThrow(/Invalid/);
  });
});

describe("parsePromptVersion", () => {
  it("splits name and version", () => {
    expect(parsePromptVersion("extract.v1")).toEqual({ name: "extract", version: "v1" });
    expect(parsePromptVersion("extract.v12")).toEqual({ name: "extract", version: "v12" });
    expect(() => parsePromptVersion("extract")).toThrow();
    expect(() => parsePromptVersion("extract.1")).toThrow();
    expect(() => parsePromptVersion("../x.v1")).toThrow();
  });
});
