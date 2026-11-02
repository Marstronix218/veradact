/**
 * Escaping for user text (statements, quotes, names, titles) in markdown exports, so it cannot
 * open headings, HTML, links, tables or emphasis. Backslash escapes keep the raw file readable for
 * coding agents and render as the literal character (CommonMark / GFM).
 */

const INLINE_SPECIAL = /[\\`*_[\]<>#|~$]/g;

function escapeSpecial(text: string): string {
  return text.replace(INLINE_SPECIAL, "\\$&");
}

/** One line of user text, safe in a heading, list item or table cell (whitespace collapsed). */
export function mdInline(text: string): string {
  return escapeSpecial(text.replace(/\s+/g, " ").trim());
}

function escapeLineStart(line: string): string {
  // Markers that open a block at the start of a line: list items, setext underlines, ordered lists.
  return line.replace(/^([-+=])/, "\\$1").replace(/^(\d+)([.)])/, "$1\\$2");
}

/** Multi-line user text as blockquote lines (`> …`), each prefixed with `indent`. */
export function mdBlockquote(text: string, indent = ""): string {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim());
  while (lines.length > 1 && lines[0] === "") lines.shift();
  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => (line === "" ? `${indent}>` : `${indent}> ${escapeLineStart(escapeSpecial(line))}`)).join("\n");
}

/** A hex digest or id as inline code (callers pass only hex/uuid/short-id values). */
export function mdCode(value: string): string {
  return `\`${value.replace(/`/g, "")}\``;
}
