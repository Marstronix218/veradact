import { describe, expect, it } from "vitest";
import { hashToken, isRandomTokenShape, randomToken } from "./tokens";

describe("tokens", () => {
  it("generates 32-byte base64url tokens", () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(isRandomTokenShape(token)).toBe(true);
  });

  it("does not repeat", () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => randomToken()));
    expect(tokens.size).toBe(1000);
  });

  it("hashes with SHA-256 to lowercase hex", () => {
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("rejects strings that are not token-shaped", () => {
    for (const value of ["", "short", `${randomToken()}=`, `${randomToken()}x`, "a".repeat(42) + "/"]) {
      expect(isRandomTokenShape(value)).toBe(false);
    }
  });
});
