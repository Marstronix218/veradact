import { describe, expect, it } from "vitest";
import { AUTHORIZATION_TEXT_VERSION, renderAuthorizationText } from "./authorization-text";

const input = { vendorName: "Quillfield Labs", engagementName: "Dispatch rollout", clientName: "Halvorsen Freight" };

describe("renderAuthorizationText", () => {
  it("names the vendor, client and engagement and covers what is stored, erasure, training and declining", () => {
    const text = renderAuthorizationText(input);
    expect(AUTHORIZATION_TEXT_VERSION).toBe("auth.v1");
    expect(text).toContain('Quillfield Labs is working with Halvorsen Freight on "Dispatch rollout"');
    expect(text).toMatch(/meeting notes, transcripts and emails/);
    expect(text).toMatch(/What is stored:/);
    expect(text).toMatch(/erase your personal data/);
    expect(text).toMatch(/not used to train or fine-tune any AI model/);
    expect(text).toMatch(/If you choose Decline, Quillfield Labs will be told, and you will not be able to confirm/);
    expect(text.length).toBeLessThan(4000);
  });

  it("is deterministic and collapses whitespace in names", () => {
    expect(renderAuthorizationText(input)).toBe(renderAuthorizationText({ ...input }));
    const text = renderAuthorizationText({ ...input, engagementName: "Dispatch\n\n  rollout" });
    expect(text).toContain('"Dispatch rollout"');
    expect(text).toBe(renderAuthorizationText(input));
  });
});
