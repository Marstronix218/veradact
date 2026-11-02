/**
 * Canonical JSON (ARCHITECTURE §4, D-008).
 *
 * - Object keys are sorted recursively by UTF-16 code unit order (`Array.prototype.sort` default),
 *   which for the ASCII keys we use is plain byte order.
 * - No whitespace; arrays keep their order; strings use `JSON.stringify` escaping.
 * - Only JSON values are accepted: `null`, booleans, strings, safe integers, arrays and plain objects.
 *   Everything else throws a `CanonicalJsonError`: `undefined` (in objects and arrays), functions,
 *   symbols, bigint, non-integer / non-finite / unsafe numbers, Dates (convert with `toISOString()`
 *   first), class instances (Map, Set, Uint8Array, ...), symbol keys and cycles.
 *
 * Error messages contain the JSON path only, never values (they may be statements).
 */

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export class CanonicalJsonError extends Error {
  readonly path: string;
  constructor(path: string, problem: string) {
    super(`canonical JSON: ${problem} at ${path}`);
    this.name = "CanonicalJsonError";
    this.path = path;
  }
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function write(value: unknown, path: string, ancestors: Set<object>): string {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError(path, "non-finite number");
      if (!Number.isInteger(value)) throw new CanonicalJsonError(path, "non-integer number");
      if (!Number.isSafeInteger(value)) throw new CanonicalJsonError(path, "unsafe integer");
      // JSON.stringify(-0) === "0", which is also what a jsonb round trip returns.
      return JSON.stringify(value);
    case "undefined":
      throw new CanonicalJsonError(path, "undefined value");
    case "function":
      throw new CanonicalJsonError(path, "function value");
    case "symbol":
      throw new CanonicalJsonError(path, "symbol value");
    case "bigint":
      throw new CanonicalJsonError(path, "bigint value");
    case "object":
      break;
  }
  if (value === null) return "null";
  const obj = value as object;
  if (ancestors.has(obj)) throw new CanonicalJsonError(path, "cycle");

  if (Array.isArray(obj)) {
    ancestors.add(obj);
    const parts: string[] = [];
    for (let i = 0; i < obj.length; i++) {
      // Holes in sparse arrays read as undefined and are rejected.
      parts.push(write(obj[i], `${path}[${i}]`, ancestors));
    }
    ancestors.delete(obj);
    return `[${parts.join(",")}]`;
  }

  if (obj instanceof Date) throw new CanonicalJsonError(path, "Date (use toISOString())");
  if (!isPlainObject(obj)) throw new CanonicalJsonError(path, "non-plain object");
  if (Object.getOwnPropertySymbols(obj).length > 0) throw new CanonicalJsonError(path, "symbol key");

  ancestors.add(obj);
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    parts.push(`${JSON.stringify(key)}:${write(record[key], childPath(path, key), ancestors)}`);
  }
  ancestors.delete(obj);
  return `{${parts.join(",")}}`;
}

/** Serializes `value` as canonical JSON or throws `CanonicalJsonError`. */
export function canonicalJson(value: unknown): string {
  return write(value, "$", new Set());
}
