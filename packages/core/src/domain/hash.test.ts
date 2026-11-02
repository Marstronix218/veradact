import { describe, expect, it } from "vitest";
import { hmacSha256Hex, sha256Hex, timingSafeEqualHex } from "./hash";

describe("sha256Hex", () => {
  it("matches known vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hashes strings as UTF-8 and accepts bytes", () => {
    expect(sha256Hex("é")).toBe(sha256Hex(new Uint8Array([0xc3, 0xa9])));
  });
});

describe("hmacSha256Hex", () => {
  it("matches RFC 4231 test case 2", () => {
    const key = new TextEncoder().encode("Jefe");
    expect(hmacSha256Hex(key, "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("depends on the key", () => {
    expect(hmacSha256Hex(new Uint8Array(32), "x")).not.toBe(hmacSha256Hex(new Uint8Array(32).fill(1), "x"));
  });
});

describe("timingSafeEqualHex", () => {
  const a = sha256Hex("a");
  it("compares equal hex, case-insensitively", () => {
    expect(timingSafeEqualHex(a, a)).toBe(true);
    expect(timingSafeEqualHex(a, a.toUpperCase())).toBe(true);
  });
  it("rejects different, different-length and malformed input", () => {
    expect(timingSafeEqualHex(a, sha256Hex("b"))).toBe(false);
    expect(timingSafeEqualHex(a, a.slice(2))).toBe(false);
    expect(timingSafeEqualHex("zz", "zz")).toBe(false);
    expect(timingSafeEqualHex("abc", "abc")).toBe(false);
    expect(timingSafeEqualHex("", "")).toBe(true);
  });
});
