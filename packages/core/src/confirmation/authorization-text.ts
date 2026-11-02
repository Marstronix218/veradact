// Written authorization a client contact grants before confirming items (ARCHITECTURE §8.3 step 2,
// D-019). The rendered text is stored verbatim in `authorization_granted` / `_declined`, so it may
// name only the vendor, the client company and the engagement — never the contact (§6).
//
// Never edit a released version in place: add a new version and bump AUTHORIZATION_TEXT_VERSION.
// A contact whose latest grant used an older version must grant again before confirming.

export const AUTHORIZATION_TEXT_VERSION = "auth.v1";

export interface AuthorizationTextInput {
  /** The vendor org's name. */
  vendorName: string;
  engagementName: string;
  /** The client company (engagement.client_name), not the contact. */
  clientName: string;
}

/** Collapses whitespace so a stored name cannot reshape the text's paragraphs. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The exact text shown to the contact and stored in the authorization event (plain text). */
export function renderAuthorizationText(input: AuthorizationTextInput): string {
  const vendor = oneLine(input.vendorName);
  const engagement = oneLine(input.engagementName);
  const client = oneLine(input.clientName);
  return [
    `${vendor} is working with ${client} on "${engagement}". To keep an accurate record of what both sides agreed, ${vendor} uses Veradact, a service that stores the items they have written down together with the passages those items were taken from.`,
    "",
    `By choosing Grant, you authorize ${vendor} to process communications you took part in for this engagement (meeting notes, transcripts and emails) in Veradact, for the purpose of keeping that record and asking you to confirm it.`,
    "",
    "What is stored:",
    "- each item and the short quotes from those communications that support it;",
    "- your response to each item (confirm or dispute), any comment you write, and when you responded;",
    "- your name and email address, and the IP address and browser details of the device you respond from, as evidence of who responded.",
    "",
    "Your choices:",
    `- You can ask ${vendor} at any time to erase your personal data. Your name, email address, comments and device details are then deleted, and the record keeps only that an erased contact responded.`,
    "- These communications and your responses are not used to train or fine-tune any AI model.",
    `- If you choose Decline, ${vendor} will be told, and you will not be able to confirm or dispute items here. You can come back to this link while it is valid and grant authorization later.`,
  ].join("\n");
}
