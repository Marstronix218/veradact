import { describe, expect, it } from "vitest";
import { isSignupEnabled, openSignupToken, orgSlug, sealSignupToken, signupUrl } from "./signup";

const secret = "s".repeat(40);
const email = "ada@example.test";
const now = new Date("2026-11-02T12:00:00.000Z");
const expiresAt = new Date(now.getTime() + 30 * 60_000);

describe("sign-up tokens", () => {
  it("round-trips the email and does not show it in the token", () => {
    const token = sealSignupToken({ secret, email, expiresAt });
    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("ada");
    expect(Buffer.from(token.slice(3), "base64url").toString("latin1")).not.toContain(email);
    expect(openSignupToken({ secret, token, now })).toBe(email);
  });

  it("is randomized: the same email seals to different tokens", () => {
    expect(sealSignupToken({ secret, email, expiresAt })).not.toBe(sealSignupToken({ secret, email, expiresAt }));
  });

  it("rejects expired tokens", () => {
    const token = sealSignupToken({ secret, email, expiresAt });
    expect(openSignupToken({ secret, token, now: expiresAt })).toBeNull();
  });

  it("rejects another secret and any modification", () => {
    const token = sealSignupToken({ secret, email, expiresAt });
    expect(openSignupToken({ secret: "t".repeat(40), token, now })).toBeNull();
    const body = Buffer.from(token.slice(3), "base64url");
    for (const index of [0, 13, body.length - 1]) {
      const tampered = Buffer.from(body);
      tampered[index]! ^= 1;
      expect(openSignupToken({ secret, token: `v1.${tampered.toString("base64url")}`, now })).toBeNull();
    }
  });

  it("rejects malformed tokens", () => {
    const token = sealSignupToken({ secret, email, expiresAt });
    for (const bad of ["", "v1", "v1.", token.replace("v1.", "v2."), `${token}.x`, `v1.${"A".repeat(40)}`]) {
      expect(openSignupToken({ secret, token: bad, now })).toBeNull();
    }
  });

  it("builds the sign-up URL", () => {
    expect(signupUrl("http://localhost:3000/", "v1.abc-_")).toBe("http://localhost:3000/signup/complete?token=v1.abc-_");
  });
});

describe("isSignupEnabled", () => {
  it("is on only for SIGNUP_ENABLED=true", () => {
    expect(isSignupEnabled({ SIGNUP_ENABLED: "true" })).toBe(true);
    expect(isSignupEnabled({ SIGNUP_ENABLED: " TRUE " })).toBe(true);
    for (const value of [undefined, "", "false", "1", "yes"]) {
      expect(isSignupEnabled({ SIGNUP_ENABLED: value })).toBe(false);
    }
  });
});

describe("orgSlug", () => {
  it("keeps a-z0-9 words of the name and appends the suffix", () => {
    expect(orgSlug("Acme Studio, Inc.", "abc123")).toBe("acme-studio-inc-abc123");
    expect(orgSlug("  Café Ünïcode  ", "abc123")).toBe("cafe-unicode-abc123");
    expect(orgSlug("株式会社", "abc123")).toBe("org-abc123");
  });

  it("fits org:create's slug rule", () => {
    const rule = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
    for (const name of ["a".repeat(200), "-- x --", "Ünïcode ".repeat(10), "!!!"]) {
      expect(orgSlug(name)).toMatch(rule);
    }
  });
});
