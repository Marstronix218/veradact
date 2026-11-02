/** Longest address SMTP accepts (RFC 5321 path limit). */
const MAX_EMAIL_LENGTH = 254;

// One plain address, the same shape @veradact/email accepts as a recipient, plus a dot in
// the domain so obvious typos ("ada@example") are caught at the form.
const EMAIL = /^[^\s@,;<>()[\]"\\]+@[^\s@,;<>()[\]"\\]+\.[^\s@,;<>()[\]"\\.]+$/;

/** Trimmed, lower-cased address, or null when it is not a single plain email address. */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return email.length <= MAX_EMAIL_LENGTH && EMAIL.test(email) ? email : null;
}
