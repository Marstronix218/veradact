import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Prompts live in packages/ai/prompts/<name>.<version>.md and are never edited once used;
// a change is a new version file (CLAUDE.md). HTML comments in a prompt file are notes for
// human reviewers and are stripped before the text is sent to a model.

export interface LoadedPrompt {
  /** "<name>.<version>", e.g. "extract.v1" — stored on extraction_run and item provenance. */
  version: string;
  text: string;
}

const DEFAULT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../prompts");
// After bundling (Next on Vercel), import.meta.url points at a compiled chunk, so DEFAULT_DIR no
// longer leads to packages/ai/prompts. The traced files keep their repo-relative layout, so also
// try paths from the working directory (the repo root, or apps/web in a monorepo deployment).
const FALLBACK_DIRS = [
  path.resolve(process.cwd(), "packages/ai/prompts"),
  path.resolve(process.cwd(), "../../packages/ai/prompts"),
];
const NAME = /^[a-z][a-z0-9-]*$/;
const VERSION = /^v[1-9]\d*$/;
const cache = new Map<string, LoadedPrompt>();

/** Load `prompts/<name>.<version>.md`. `dir` overrides the prompts directory (e.g. for bundled deployments). */
export function loadPrompt(name: string, version: string, options: { dir?: string } = {}): LoadedPrompt {
  if (!NAME.test(name) || !VERSION.test(version)) throw new Error("Invalid prompt name or version");
  const dirs = options.dir ? [options.dir] : [DEFAULT_DIR, ...FALLBACK_DIRS];
  let file = "";
  let source: string | undefined;
  for (const dir of dirs) {
    file = path.join(dir, `${name}.${version}.md`);
    const cached = cache.get(file);
    if (cached) return cached;
    try {
      source = fs.readFileSync(file, "utf8");
      break;
    } catch {
      // try the next directory
    }
  }
  if (source === undefined) {
    // `code` is what logError records; the message names no path or content.
    throw Object.assign(new Error(`Prompt not found: ${name}.${version}`), { code: "prompt_not_found" });
  }
  const text = source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const prompt = { version: `${name}.${version}`, text };
  cache.set(file, prompt);
  return prompt;
}

/** "extract.v1" → { name: "extract", version: "v1" }. */
export function parsePromptVersion(promptVersion: string): { name: string; version: string } {
  const dot = promptVersion.lastIndexOf(".");
  const name = promptVersion.slice(0, dot);
  const version = promptVersion.slice(dot + 1);
  if (dot <= 0 || !NAME.test(name) || !VERSION.test(version)) throw new Error("Invalid prompt version string");
  return { name, version };
}
