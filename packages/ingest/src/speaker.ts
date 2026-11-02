// Conservative speaker-label detection. Labels are returned exactly as written; nothing is
// inferred. A label is 1-4 words before a colon at the start of a line, each word starting with
// an uppercase (or caseless, e.g. CJK) letter; digits ("Speaker 2") and short lowercase
// particles ("van", "de") are allowed after the first word. Header words ("From:", "Note:")
// are not speakers.

const WORD_FIRST = String.raw`[\p{Lu}\p{Lt}\p{Lo}][\p{L}\p{M}'’.\-]*`;
const WORD_REST = String.raw`(?:${WORD_FIRST}|\d+|\p{Ll}{1,3})`;
const LABEL = new RegExp(String.raw`^(${WORD_FIRST}(?: ${WORD_REST}){0,3}):[ \t]+(?=\S)`, "u");
const MAX_LABEL_CHARS = 40;

// Lower-cased labels that introduce headers or note fields rather than a person.
const NOT_SPEAKERS = new Set([
  "a", "action", "action items", "actions", "agenda", "answer", "attendees", "author", "bcc", "cc",
  "comment", "comments", "context", "date", "decision", "decisions", "edit", "fw", "fwd", "fyi",
  "goal", "goals", "important", "location", "nb", "next steps", "note", "notes", "owner",
  "participants", "ps", "q", "question", "questions", "re", "reply", "sent", "status", "subject",
  "summary", "time", "title", "to", "todo", "topic", "update", "warning", "from",
]);

// Markdown/plain-text list or quote markers stripped before looking for a label.
const LIST_MARKER = /^\s*(?:>\s*)*(?:[-*+•]|\d{1,3}[.)])\s+/u;

/** Speaker label at the start of `line`, or null. */
export function leadingSpeakerLabel(line: string, options: { allowListMarker?: boolean } = {}): string | null {
  const body = options.allowListMarker ? line.replace(LIST_MARKER, "") : line;
  const m = LABEL.exec(body);
  if (!m) return null;
  const label = m[1] ?? "";
  if (label.length > MAX_LABEL_CHARS || NOT_SPEAKERS.has(label.toLowerCase())) return null;
  return label;
}
