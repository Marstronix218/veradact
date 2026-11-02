import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { clientLinkUrl, linkSigningSecret, parseLinkToken, signLinkToken } from "./link-token";

const secret = "s".repeat(40);
const linkId = "3b1f6c1e-1d2a-4c3b-9a8e-7f6d5c4b3a21";
const contactId = "9a8e7f6d-5c4b-4a21-8b1f-6c1e1d2a4c3b";
const expiresAt = new Date("2026-11-15T12:34:56.789Z");

describe("link tokens", () => {
  it("is v1.<link_id>.<exp seconds>.<base64url HMAC over v1|link|contact|exp>", () => {
    const token = signLinkToken({ secret, linkId, contactId, expiresAt });
    const exp = Math.floor(expiresAt.getTime() / 1000);
    const sig = createHmac("sha256", secret).update(`v1|${linkId}|${contactId}|${exp}`).digest("base64url");
    expect(token).toBe(`v1.${linkId}.${exp}.${sig}`);
    expect(parseLinkToken(token)).toEqual({ linkId, exp, sig });
    // Deterministic: a reminder re-signs the same link to the same token.
    expect(signLinkToken({ secret, linkId, contactId, expiresAt })).toBe(token);
  });

  it("binds the contact: another contact id gives another signature", () => {
    const a = signLinkToken({ secret, linkId, contactId, expiresAt });
    const b = signLinkToken({ secret, linkId, contactId: linkId, expiresAt });
    expect(a).not.toBe(b);
  });

  it("rejects malformed tokens", () => {
    const token = signLinkToken({ secret, linkId, contactId, expiresAt });
    for (const bad of ["", "v1", token.replace("v1.", "v2."), `${token}x`, token.toUpperCase(), token.replace(/\.(\d+)\./, ".-1."), `${token}.extra`]) {
      expect(parseLinkToken(bad)).toBeNull();
    }
  });

  it("builds the client URL", () => {
    expect(clientLinkUrl("http://localhost:3000/", "v1.x")).toBe("http://localhost:3000/c/v1.x");
  });

  it("requires a 32+ character secret", () => {
    expect(() => linkSigningSecret({})).toThrow(/LINK_SIGNING_SECRET/);
    expect(() => linkSigningSecret({ LINK_SIGNING_SECRET: "short" })).toThrow(/at least 32/);
    expect(linkSigningSecret({ LINK_SIGNING_SECRET: ` ${secret} ` })).toBe(secret);
  });
});
