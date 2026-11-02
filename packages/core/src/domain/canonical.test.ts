import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalJson, CanonicalJsonError } from "./canonical";

describe("canonicalJson", () => {
  it("sorts keys recursively and emits no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}',
    );
  });

  it("keeps array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("handles primitives, empty containers and string escaping", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson(0)).toBe("0");
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson(-42)).toBe("-42");
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson([])).toBe("[]");
    expect(canonicalJson('a"b\\c\n\u0001é🚚')).toBe(JSON.stringify('a"b\\c\n\u0001é🚚'));
  });

  it("sorts keys by UTF-16 code units", () => {
    expect(canonicalJson({ b: 1, B: 2, a: 3, _: 4, "10": 5, "9": 6 })).toBe('{"10":5,"9":6,"B":2,"_":4,"a":3,"b":1}');
  });

  it("accepts null-prototype objects", () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.b = 1;
    o.a = 2;
    expect(canonicalJson(o)).toBe('{"a":2,"b":1}');
  });

  it("is independent of key insertion order (property)", () => {
    const json: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
      value: fc.oneof(
        { depthSize: "small" },
        fc.constant(null),
        fc.boolean(),
        fc.maxSafeInteger(),
        fc.string(),
        fc.array(tie("value")),
        fc.dictionary(fc.string(), tie("value")),
      ),
    })).value;
    const shuffleKeys = (v: unknown, seed: number): unknown => {
      if (Array.isArray(v)) return v.map((x, i) => shuffleKeys(x, seed + i));
      if (v !== null && typeof v === "object") {
        const entries = Object.entries(v);
        const rotated = entries.map((_, i) => entries[(i + seed) % entries.length]!).reverse();
        const out: Record<string, unknown> = {};
        for (const [k, x] of rotated) out[k] = shuffleKeys(x, seed + 1);
        return out;
      }
      return v;
    };
    fc.assert(
      fc.property(json, fc.nat(), (v, seed) => {
        const a = canonicalJson(v);
        expect(canonicalJson(shuffleKeys(v, seed))).toBe(a);
        expect(JSON.parse(a)).toEqual(v);
      }),
      { numRuns: 200 },
    );
  });

  describe("rejections", () => {
    const cases: [string, unknown, string][] = [
      ["undefined at top level", undefined, "$"],
      ["undefined in an object", { a: 1, b: undefined }, "$.b"],
      ["undefined in an array", [1, undefined], "$[1]"],
      ["sparse array hole", [1, , 3], "$[1]"],
      ["function", { f: () => 1 }, "$.f"],
      ["symbol value", { s: Symbol("x") }, "$.s"],
      ["bigint", { n: 1n }, "$.n"],
      ["non-integer", { n: 1.5 }, "$.n"],
      ["NaN", { n: Number.NaN }, "$.n"],
      ["Infinity", [Number.POSITIVE_INFINITY], "$[0]"],
      ["-Infinity", { deep: { n: Number.NEGATIVE_INFINITY } }, "$.deep.n"],
      ["unsafe integer", { n: 2 ** 53 }, "$.n"],
      ["Date", { at: new Date(0) }, "$.at"],
      ["Map", { m: new Map() }, "$.m"],
      ["Set", [new Set()], "$[0]"],
      ["Uint8Array", { b: new Uint8Array(2) }, "$.b"],
      ["class instance", { c: new (class Foo {})() }, "$.c"],
      ["symbol key", { [Symbol("k")]: 1 }, "$"],
      ["odd key path", { "a b": undefined }, '$["a b"]'],
    ];
    it.each(cases)("rejects %s", (_name, value, path) => {
      let error: unknown;
      try {
        canonicalJson(value);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(CanonicalJsonError);
      expect((error as CanonicalJsonError).path).toBe(path);
    });

    it("rejects cycles", () => {
      const a: Record<string, unknown> = {};
      a.self = a;
      expect(() => canonicalJson(a)).toThrow(CanonicalJsonError);
      const arr: unknown[] = [];
      arr.push(arr);
      expect(() => canonicalJson(arr)).toThrow(/cycle/);
    });

    it("allows the same object twice when it is not a cycle", () => {
      const shared = { x: 1 };
      expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
    });

    it("does not echo values in error messages", () => {
      expect(() => canonicalJson({ statement: "secret text", n: 0.5 })).toThrow(/^canonical JSON: non-integer number at \$\.n$/);
    });
  });
});
