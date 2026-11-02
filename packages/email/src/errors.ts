import type { EmailMessage } from "./types";

/**
 * Stable, PII-free failure codes. The SMTP codes are nodemailer's; anything else maps to
 * `EUNKNOWN`. `EENVELOPE` is also used for a `to` that is not a single plain address.
 */
export type EmailDeliveryErrorCode =
  | "ECONNECTION"
  | "ETIMEDOUT"
  | "ESOCKET"
  | "EDNS"
  | "ETLS"
  | "EPROTOCOL"
  | "EENVELOPE"
  | "EMESSAGE"
  | "EAUTH"
  | "ECONFIG"
  | "EUNKNOWN";

const KNOWN_CODES: ReadonlySet<string> = new Set<EmailDeliveryErrorCode>([
  "ECONNECTION",
  "ETIMEDOUT",
  "ESOCKET",
  "EDNS",
  "ETLS",
  "EPROTOCOL",
  "EENVELOPE",
  "EMESSAGE",
  "EAUTH",
  "ECONFIG",
]);

/**
 * Delivery failure. The message carries the code only: no recipient, subject, body, SMTP
 * response text or underlying `cause` (provider errors routinely quote the address).
 */
export class EmailDeliveryError extends Error {
  readonly code: EmailDeliveryErrorCode;

  constructor(code: EmailDeliveryErrorCode) {
    super(`Email delivery failed (${code})`);
    this.name = "EmailDeliveryError";
    this.code = code;
  }
}

/** Maps an arbitrary thrown value to a known code without reading anything but `code`. */
export function deliveryCodeOf(err: unknown): EmailDeliveryErrorCode {
  const code =
    typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && KNOWN_CODES.has(code)
    ? (code as EmailDeliveryErrorCode)
    : "EUNKNOWN";
}

// One plain address: no whitespace, display name, quoting, comments or list separators.
const SINGLE_ADDRESS = /^[^\s@,;<>()[\]"\\]+@[^\s@,;<>()[\]"\\]+$/;

/** Rejects anything but a single bare address, so `to` can never fan out to several recipients. */
export function assertSingleRecipient(msg: Pick<EmailMessage, "to">): void {
  if (msg.to.length > 254 || !SINGLE_ADDRESS.test(msg.to)) {
    throw new EmailDeliveryError("EENVELOPE");
  }
}
