// Confirmation emails (ARCHITECTURE §8): link + reminder to the contact, receipt to the contact
// (D-020), dispute and decline notices to the member who sent the request. Plain text plus a
// simple HTML part: no images, no tracking pixels, no remote resources, no item content except in
// the contact's own receipt. Tags carry ids and enums only.
import type { EmailMessage } from "@veradact/email";
import type { ResponseDecision } from "../domain";
import type { ConfirmationDelivery } from "./channels";
import type { ClientReceipt } from "./client-actions";
import { formatDateTime, formatLongDate } from "./format";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const BODY_STYLE =
  "margin:0 auto;padding:16px;max-width:560px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#18181b";
const BUTTON_STYLE =
  "display:inline-block;padding:12px 20px;background:#18181b;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600";

/** `blocks` are already-escaped HTML fragments. */
function htmlDocument(blocks: string[]): string {
  return `<!doctype html><html><body style="${BODY_STYLE}">${blocks.join("")}</body></html>`;
}

const p = (escapedHtml: string) => `<p>${escapedHtml}</p>`;

function linkBlock(url: string, label: string): string {
  const href = escapeHtml(url);
  return (
    p(`<a href="${href}" style="${BUTTON_STYLE}">${escapeHtml(label)}</a>`) +
    p(`If the button does not work, copy this link into your browser:<br><span style="word-break:break-all">${href}</span>`)
  );
}

/** First email (kind "request") or the single reminder (kind "reminder") with the signed link. */
export function confirmationLinkEmail(d: ConfirmationDelivery): EmailMessage {
  const items = plural(d.request.itemCount, "item", "items");
  const who = d.requesterName ? `${d.requesterName} at ${d.vendorName}` : d.vendorName;
  const expires = formatLongDate(d.link.expiresAt, d.engagement.timeZone);
  const reminder = d.kind === "reminder";
  const subject = reminder
    ? `Reminder: ${d.vendorName} is waiting for you to confirm ${items}`
    : `${d.vendorName} asks you to confirm ${items} for ${d.engagement.name}`;
  const intro = reminder
    ? `This is a reminder: ${who} asked you to confirm ${items} recorded for "${d.engagement.name}". This is the only reminder you will get.`
    : `${who} asks you to confirm ${items} recorded for "${d.engagement.name}".`;
  const explain = `Veradact keeps a record of what was agreed between ${d.vendorName} and ${d.engagement.clientName}. For each item you can confirm it, dispute it with a comment, or skip it.`;
  const expiry = `This link is personal to you and expires on ${expires}. No account or password is needed.`;
  const ignore = "If you were not expecting this email, you can ignore it.";

  const text = [`Hello ${d.contact.name},`, "", intro, "", explain, "", "Review the items:", d.url, "", expiry, "", ignore, ""].join("\n");
  const html = htmlDocument([
    p(`Hello ${escapeHtml(d.contact.name)},`),
    p(escapeHtml(intro)),
    p(escapeHtml(explain)),
    linkBlock(d.url, "Review the items"),
    p(escapeHtml(expiry)),
    p(`<span style="color:#52525b">${escapeHtml(ignore)}</span>`),
  ]);
  return {
    to: d.contact.email,
    subject,
    text,
    html,
    tags: { kind: reminder ? "confirmation_reminder" : "confirmation_request", request_id: d.request.id },
  };
}

const DECISION_LABEL: Record<ResponseDecision, string> = { confirmed: "Confirmed", disputed: "Disputed" };

/** The contact's receipt (D-020): what was recorded, each version hash, and the log head. */
export function receiptEmail(receipt: ClientReceipt, to: string): EmailMessage {
  const when = formatDateTime(receipt.recordedAt, receipt.timeZone);
  const subject = `Receipt: your responses for ${receipt.engagementName} were recorded`;
  const intro = `Your responses to ${receipt.vendorName} for "${receipt.engagementName}" were recorded on ${when}.`;
  const keep =
    "Keep this email. The hashes identify exactly what you responded to. If the record were ever changed, they would no longer match.";
  const head = `Ledger position after your responses: entry ${receipt.head.seq}, hash ${receipt.head.hash}`;

  const lines = receipt.items.flatMap((i) => [
    `${i.shortId} · ${DECISION_LABEL[i.decision]} · version ${i.version}`,
    `  ${i.statement}`,
    `  Content hash: ${i.contentHash}`,
    "",
  ]);
  const text = [`Hello ${receipt.contactName},`, "", intro, "", ...lines, head, "", keep, ""].join("\n");
  const rows = receipt.items
    .map(
      (i) =>
        `<li style="margin:0 0 12px"><strong>${escapeHtml(i.shortId)} · ${DECISION_LABEL[i.decision]}</strong> · version ${i.version}<br>` +
        `${escapeHtml(i.statement)}<br><span style="font-family:monospace;font-size:13px;word-break:break-all">Content hash: ${escapeHtml(i.contentHash)}</span></li>`,
    )
    .join("");
  const html = htmlDocument([
    p(`Hello ${escapeHtml(receipt.contactName)},`),
    p(escapeHtml(intro)),
    `<ul style="padding-left:20px">${rows}</ul>`,
    p(`<span style="font-family:monospace;font-size:13px;word-break:break-all">${escapeHtml(head)}</span>`),
    p(escapeHtml(keep)),
  ]);
  return { to, subject, text, html, tags: { kind: "confirmation_receipt", submission_id: receipt.submissionId } };
}

export interface VendorNoticeInput {
  to: string;
  requesterName: string;
  contactName: string;
  engagementName: string;
  /** The engagement's confirmations page. */
  url: string;
}

/** To the requester: a contact disputed items (ids only; the comment stays in the app). */
export function disputeNotificationEmail(input: VendorNoticeInput & { shortIds: readonly string[] }): EmailMessage {
  const items = plural(input.shortIds.length, "item", "items");
  const subject = `${input.contactName} disputed ${items} in ${input.engagementName}`;
  const body = `${input.contactName} disputed ${items} in "${input.engagementName}": ${input.shortIds.join(", ")}. Open Veradact to read their comments, then revise or withdraw the items.`;
  const text = [`Hello ${input.requesterName},`, "", body, "", input.url, ""].join("\n");
  const html = htmlDocument([p(`Hello ${escapeHtml(input.requesterName)},`), p(escapeHtml(body)), linkBlock(input.url, "Review the disputes")]);
  return { to: input.to, subject, text, html, tags: { kind: "dispute_notification" } };
}

/** To the requester: a contact declined authorization and cannot confirm items. */
export function declineNotificationEmail(input: VendorNoticeInput): EmailMessage {
  const subject = `${input.contactName} declined authorization for ${input.engagementName}`;
  const body = `${input.contactName} declined the written authorization for "${input.engagementName}", so they cannot confirm or dispute items. They can return to their link and grant it while the link is valid.`;
  const text = [`Hello ${input.requesterName},`, "", body, "", input.url, ""].join("\n");
  const html = htmlDocument([p(`Hello ${escapeHtml(input.requesterName)},`), p(escapeHtml(body)), linkBlock(input.url, "Open the confirmation requests")]);
  return { to: input.to, subject, text, html, tags: { kind: "authorization_declined_notification" } };
}
