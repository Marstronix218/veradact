import { describe, expect, it } from "vitest";
import {
  buildAttestation,
  DEFAULT_ALL_PARTY_STATES,
  DEFAULT_CONSENT_POLICY,
  evaluateConsent,
  normalizeJurisdiction,
  type ConsentInput,
} from "./consent";
import { Attestation } from "./events";
import { testUuid } from "./testing/log-builder";

const transcript: ConsentInput = {
  sourceType: "machine_transcript",
  format: "txt",
  allParticipantsConsented: null,
  jurisdictions: ["NY"],
  jurisdictionsKnown: true,
};

describe("normalizeJurisdiction", () => {
  it.each([
    ["CA", "CA"],
    ["ca", "CA"],
    [" Ca ", "CA"],
    ["US-CA", "CA"],
    ["us-wa", "WA"],
    ["US_NY", "NY"],
    ["US TX", "TX"],
    ["California", "CA"],
    ["new  york", "NY"],
    ["District of Columbia", "DC"],
    ["GB", "GB"],
    ["DE", "DE"],
  ])("%s → %s", (raw, code) => {
    expect(normalizeJurisdiction(raw)).toBe(code);
  });

  it.each(["", "C", "Californa", "USA-CA", "U.S.", "Germany", "DE-BY"])("does not recognize %j", (raw) => {
    expect(normalizeJurisdiction(raw)).toBeNull();
  });
});

describe("evaluateConsent", () => {
  it("has the default all-party list", () => {
    expect(DEFAULT_ALL_PARTY_STATES).toEqual(["CA", "CT", "DE", "FL", "IL", "MD", "MA", "MT", "NV", "NH", "OR", "PA", "WA"]);
    expect(DEFAULT_CONSENT_POLICY.blockUnknownJurisdictions).toBe(true);
  });

  it("always allows human notes, emails and chat exports", () => {
    for (const sourceType of ["human_notes", "email", "chat_export"] as const) {
      const r = evaluateConsent({ ...transcript, sourceType, jurisdictions: ["CA"], jurisdictionsKnown: false }, DEFAULT_CONSENT_POLICY);
      expect(r).toMatchObject({ decision: "allowed", rule: "not_machine_transcript", effectiveSourceType: sourceType });
    }
  });

  it("forces machine_transcript for .vtt and .srt", () => {
    for (const format of ["vtt", "srt"] as const) {
      const r = evaluateConsent({ ...transcript, sourceType: "human_notes", format, jurisdictions: ["CA"] }, DEFAULT_CONSENT_POLICY);
      expect(r).toMatchObject({ decision: "blocked", rule: "all_party_state_without_consent", effectiveSourceType: "machine_transcript" });
    }
  });

  it("allows a transcript when consent is attested", () => {
    const r = evaluateConsent({ ...transcript, allParticipantsConsented: true, jurisdictions: ["CA"] }, DEFAULT_CONSENT_POLICY);
    expect(r).toMatchObject({ decision: "allowed", rule: "consent_attested" });
  });

  it("blocks an unattested transcript with a participant in an all-party state and explains how to proceed", () => {
    const r = evaluateConsent(
      { ...transcript, allParticipantsConsented: false, jurisdictions: ["NY", "us-wa", "California"] },
      DEFAULT_CONSENT_POLICY,
    );
    expect(r.decision).toBe("blocked");
    if (r.decision !== "blocked") return;
    expect(r.rule).toBe("all_party_state_without_consent");
    expect(r.blockingStates).toEqual(["CA", "WA"]);
    expect(r.jurisdictions).toEqual(["CA", "NY", "WA"]);
    expect(r.explanation).toContain("California (CA) and Washington (WA)");
    expect(r.explanation).toContain("confirm that every participant consented");
  });

  it("allows an unattested transcript when every jurisdiction is known and none is all-party", () => {
    const r = evaluateConsent({ ...transcript, jurisdictions: ["NY", "US-TX", "GB"] }, DEFAULT_CONSENT_POLICY);
    expect(r).toMatchObject({ decision: "allowed", rule: "no_all_party_jurisdiction", jurisdictionsKnown: true });
  });

  it("blocks unknown jurisdictions by default (D-013)", () => {
    const cases: Partial<ConsentInput>[] = [
      { jurisdictions: [], jurisdictionsKnown: false },
      { jurisdictions: ["NY"], jurisdictionsKnown: false },
      { jurisdictions: [], jurisdictionsKnown: true },
      { jurisdictions: ["NY", "Californa"], jurisdictionsKnown: true },
    ];
    for (const c of cases) {
      const r = evaluateConsent({ ...transcript, ...c }, DEFAULT_CONSENT_POLICY);
      expect(r).toMatchObject({ decision: "blocked", rule: "unknown_jurisdiction_without_consent", jurisdictionsKnown: false });
      expect(r.explanation).toContain("California (CA)");
      expect(r.explanation).toContain("confirm that every participant consented");
    }
    const typo = evaluateConsent({ ...transcript, jurisdictions: ["Californa"] }, DEFAULT_CONSENT_POLICY);
    expect(typo.unrecognizedJurisdictions).toEqual(["Californa"]);
    expect(typo.explanation).toContain('"Californa"');
  });

  it("allows unknown jurisdictions when the org turned blocking off", () => {
    const r = evaluateConsent({ ...transcript, jurisdictions: [], jurisdictionsKnown: false }, { ...DEFAULT_CONSENT_POLICY, blockUnknownJurisdictions: false });
    expect(r).toMatchObject({ decision: "allowed", rule: "unknown_jurisdiction_permitted" });
    const stillBlocked = evaluateConsent({ ...transcript, jurisdictions: ["CA"], jurisdictionsKnown: false }, { ...DEFAULT_CONSENT_POLICY, blockUnknownJurisdictions: false });
    expect(stillBlocked.rule).toBe("all_party_state_without_consent");
  });

  it("respects an org-configured list in any accepted notation", () => {
    const policy = { allPartyStates: ["ny", "US-TX"], blockUnknownJurisdictions: true };
    expect(evaluateConsent({ ...transcript, jurisdictions: ["New York"] }, policy).decision).toBe("blocked");
    expect(evaluateConsent({ ...transcript, jurisdictions: ["CA"] }, policy).decision).toBe("allowed");
  });
});

describe("buildAttestation", () => {
  it("builds a valid source_ingested attestation snapshot", () => {
    const input = { ...transcript, format: "vtt" as const, allParticipantsConsented: true, jurisdictions: ["us-ca", "GB"] };
    const policy = { allPartyStates: ["wa", "CA", "CA"], blockUnknownJurisdictions: true };
    const result = evaluateConsent(input, policy);
    const attestation = buildAttestation(input, policy, result, testUuid("u"));
    expect(attestation).toEqual({
      attested_by: testUuid("u"),
      source_type: "machine_transcript",
      all_participants_consented: true,
      participant_jurisdictions: ["CA", "GB"],
      jurisdictions_known: true,
      policy: { version: 1, all_party_states: ["CA", "WA"], block_unknown_jurisdictions: true },
      decision: "allowed",
      rule: "consent_attested",
    });
    expect(Attestation.safeParse(attestation).success).toBe(true);
  });

  it("refuses a blocked result", () => {
    const result = evaluateConsent({ ...transcript, jurisdictions: ["CA"] }, DEFAULT_CONSENT_POLICY);
    expect(() => buildAttestation(transcript, DEFAULT_CONSENT_POLICY, result, testUuid("u"))).toThrow(/blocked/);
  });
});
