/**
 * Consent policy for ingesting sources (ARCHITECTURE §9.2, D-013). Pure.
 *
 * Jurisdiction codes are normalized (`normalizeJurisdiction`):
 * - surrounding whitespace is ignored and matching is case-insensitive;
 * - `XX` (two letters) is kept as is, upper-cased. A two-letter code that is a US state or DC code
 *   is read as that state (so `DE` means Delaware, not Germany: the conservative reading, since only
 *   US states are on the all-party list and attesting consent always lets the uploader proceed);
 * - `US-XX` / `US_XX` / `US XX` becomes `XX`;
 * - a full US state name (`California`, `new york`, `District of Columbia`) becomes its code;
 * - anything else is unrecognized and is treated as an unknown jurisdiction.
 */
import type { Attestation, ConsentAllowedRule, SourceFormat, SourceType } from "./events";

export const CONSENT_POLICY_VERSION = 1;

export const DEFAULT_ALL_PARTY_STATES: readonly string[] = [
  "CA",
  "CT",
  "DE",
  "FL",
  "IL",
  "MD",
  "MA",
  "MT",
  "NV",
  "NH",
  "OR",
  "PA",
  "WA",
];

export const US_STATE_NAMES: Readonly<Record<string, string>> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};

const STATE_BY_NAME: ReadonlyMap<string, string> = new Map(
  Object.entries(US_STATE_NAMES).map(([code, name]) => [name.toUpperCase(), code]),
);

/** Normalized code, or null when the value is not recognized (see module comment). */
export function normalizeJurisdiction(raw: string): string | null {
  const value = raw.trim().replace(/\s+/g, " ").toUpperCase();
  if (/^[A-Z]{2}$/.test(value)) return value;
  const us = /^US[-_ ]([A-Z]{2})$/.exec(value);
  if (us) return us[1]!;
  return STATE_BY_NAME.get(value) ?? null;
}

export interface ConsentPolicy {
  allPartyStates: readonly string[];
  blockUnknownJurisdictions: boolean;
}

export const DEFAULT_CONSENT_POLICY: ConsentPolicy = {
  allPartyStates: DEFAULT_ALL_PARTY_STATES,
  blockUnknownJurisdictions: true,
};

export interface ConsentInput {
  sourceType: SourceType;
  format: SourceFormat;
  /** Attestation that every participant consented to the recording; null = not answered. */
  allParticipantsConsented: boolean | null;
  /** Participant states or countries, as entered. */
  jurisdictions: readonly string[];
  /** The uploader says they know every participant's jurisdiction. */
  jurisdictionsKnown: boolean;
}

export type ConsentBlockedRule = "all_party_state_without_consent" | "unknown_jurisdiction_without_consent";

interface ConsentResultBase {
  /** `machine_transcript` for `.vtt`/`.srt` regardless of what was selected. */
  effectiveSourceType: SourceType;
  /** Recognized jurisdictions, normalized, de-duplicated and sorted. */
  jurisdictions: string[];
  /** Entries that could not be recognized (they count as unknown). */
  unrecognizedJurisdictions: string[];
  /** Whether every participant's jurisdiction is known and recognized. */
  jurisdictionsKnown: boolean;
  /** Human-readable explanation for the uploader. */
  explanation: string;
}

export type ConsentResult =
  | (ConsentResultBase & { decision: "allowed"; rule: ConsentAllowedRule })
  | (ConsentResultBase & { decision: "blocked"; rule: ConsentBlockedRule; blockingStates: string[] });

const MACHINE_TRANSCRIPT_FORMATS: ReadonlySet<SourceFormat> = new Set<SourceFormat>(["vtt", "srt"]);

function describeStates(codes: readonly string[]): string {
  const names = codes.map((c) => (US_STATE_NAMES[c] ? `${US_STATE_NAMES[c]} (${c})` : c));
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const HOW_TO_PROCEED =
  "To proceed, confirm that every participant consented to being recorded and transcribed, " +
  "or upload human-written notes of the conversation instead.";

export function evaluateConsent(input: ConsentInput, policy: ConsentPolicy): ConsentResult {
  const effectiveSourceType: SourceType = MACHINE_TRANSCRIPT_FORMATS.has(input.format)
    ? "machine_transcript"
    : input.sourceType;
  const recognized = new Set<string>();
  const unrecognized: string[] = [];
  for (const raw of input.jurisdictions) {
    if (raw.trim() === "") continue;
    const code = normalizeJurisdiction(raw);
    if (code) recognized.add(code);
    else unrecognized.push(raw.trim());
  }
  const jurisdictions = [...recognized].sort();
  const jurisdictionsKnown = input.jurisdictionsKnown && jurisdictions.length > 0 && unrecognized.length === 0;
  const base = { effectiveSourceType, jurisdictions, unrecognizedJurisdictions: unrecognized, jurisdictionsKnown };

  if (effectiveSourceType !== "machine_transcript") {
    return {
      ...base,
      decision: "allowed",
      rule: "not_machine_transcript",
      explanation: "Human-written notes, emails and chat exports can always be added.",
    };
  }
  if (input.allParticipantsConsented === true) {
    return {
      ...base,
      decision: "allowed",
      rule: "consent_attested",
      explanation: "You attested that every participant consented to the recording.",
    };
  }

  const allParty = new Set(policy.allPartyStates.map((s) => normalizeJurisdiction(s)).filter((s): s is string => s !== null));
  const blockingStates = jurisdictions.filter((j) => allParty.has(j));
  if (blockingStates.length > 0) {
    return {
      ...base,
      decision: "blocked",
      rule: "all_party_state_without_consent",
      blockingStates,
      explanation:
        `This machine transcript includes participants in ${describeStates(blockingStates)}, ` +
        `where every party must consent to a recording, and consent from all participants was not attested. ${HOW_TO_PROCEED}`,
    };
  }

  if (!jurisdictionsKnown) {
    const unknownDetail =
      unrecognized.length > 0
        ? `We could not recognize ${unrecognized.map((u) => `"${u}"`).join(", ")} as a US state or country code.`
        : "The participants' locations are not known.";
    if (policy.blockUnknownJurisdictions) {
      return {
        ...base,
        decision: "blocked",
        rule: "unknown_jurisdiction_without_consent",
        blockingStates: [],
        explanation:
          `${unknownDetail} Some participants may be in a state where every party must consent to a recording ` +
          `(${describeStates(policy.allPartyStates)}), and consent from all participants was not attested. ` +
          `${HOW_TO_PROCEED} You can also list every participant's state or country (for example CA, US-NY or GB).`,
      };
    }
    return {
      ...base,
      decision: "allowed",
      rule: "unknown_jurisdiction_permitted",
      explanation: `${unknownDetail} Your organization allows machine transcripts with unknown participant locations.`,
    };
  }

  return {
    ...base,
    decision: "allowed",
    rule: "no_all_party_jurisdiction",
    explanation: "No participant is in a state that requires every party's consent to a recording.",
  };
}

/**
 * The `source_ingested.attestation` payload for an allowed result. Throws for a blocked result
 * (blocked sources are never ingested).
 */
export function buildAttestation(
  input: ConsentInput,
  policy: ConsentPolicy,
  result: ConsentResult,
  attestedBy: string,
): Attestation {
  if (result.decision !== "allowed") throw new Error(`consent blocked: ${result.rule}`);
  return {
    attested_by: attestedBy,
    source_type: result.effectiveSourceType,
    all_participants_consented: input.allParticipantsConsented,
    participant_jurisdictions: result.jurisdictions,
    jurisdictions_known: result.jurisdictionsKnown,
    policy: {
      version: CONSENT_POLICY_VERSION,
      all_party_states: [...new Set(policy.allPartyStates.map((s) => normalizeJurisdiction(s) ?? s.trim().toUpperCase()))].sort(),
      block_unknown_jurisdictions: policy.blockUnknownJurisdictions,
    },
    decision: "allowed",
    rule: result.rule,
  };
}
