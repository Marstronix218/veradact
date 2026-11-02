// A small auto-escaping `html` tagged template for the client pages (ARCHITECTURE §8.3). Every
// interpolated value is HTML-escaped unless it is a `SafeHtml` produced by `html` itself or
// explicitly marked with `unsafeRaw` (for trusted constants only). Arrays render element by
// element with the same rules; null, undefined and false render nothing.
//
// Interpolate attribute values only inside quotes: <input value="${v}">. Never interpolate into
// a tag name, an attribute name, an unquoted attribute, a URL scheme, <script> or <style>.

const SAFE = Symbol("SafeHtml");

export interface SafeHtml {
  readonly [SAFE]: true;
  readonly value: string;
  toString(): string;
}

function safe(value: string): SafeHtml {
  return { [SAFE]: true, value, toString: () => value };
}

export function isSafeHtml(value: unknown): value is SafeHtml {
  return typeof value === "object" && value !== null && (value as { [SAFE]?: unknown })[SAFE] === true;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (ch) => ESCAPES[ch]!);
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === false) return "";
  if (isSafeHtml(value)) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) out += render(values[i]) + (strings[i + 1] ?? "");
  return safe(out);
}

/** Marks a trusted constant string as HTML. Never pass user, client or database text. */
export function unsafeRaw(trusted: string): SafeHtml {
  return safe(trusted);
}
