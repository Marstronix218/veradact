// Client confirmation pages (ARCHITECTURE §8.3): plain HTML from the escaping `html` template, no
// JavaScript, no third-party resources, one same-origin stylesheet. Every function returns a full
// document; route handlers add the security headers (respond.ts).
import {
  formatDateTime,
  formatLongDate,
  formatShortDate,
  type ClientFieldError,
  type ClientReceipt,
  type ClientView,
  type ClientViewItem,
  type Kind,
  type SourceType,
} from "@veradact/core";
import { html, type SafeHtml } from "./html";

export const CLIENT_STYLESHEET_PATH = "/c/static/client.css";

const KIND_LABEL: Record<Kind, string> = {
  problem: "Problem",
  constraint: "Constraint",
  assumption: "Assumption",
  decision: "Decision",
  requirement: "Requirement",
};

const SOURCE_LABEL: Record<SourceType, string> = {
  human_notes: "Meeting notes",
  machine_transcript: "Transcript",
  email: "Email",
  chat_export: "Chat",
};

export type Decision = "confirm" | "dispute" | "skip";

/** What the contact entered, re-shown after a rejected submission. */
export interface FormValues {
  decision: Decision;
  comment: string;
}

export interface Notice {
  tone: "info" | "error" | "ok";
  text: string;
}

function document(title: string, body: SafeHtml): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<link rel="stylesheet" href="${CLIENT_STYLESHEET_PATH}">
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`.value;
}

const pageUrl = (token: string) => `/c/${token}`;
const itemsUrl = (token: string) => `/c/${token}?step=items`;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function noticeBlock(notice: Notice | undefined): SafeHtml | null {
  if (!notice) return null;
  const cls = notice.tone === "info" ? "notice" : `notice ${notice.tone}`;
  return html`<div class="${cls}" role="${notice.tone === "error" ? "alert" : "status"}"><p>${notice.text}</p></div>`;
}

function header(view: Pick<ClientView, "vendorName" | "clientName">, title: string): SafeHtml {
  return html`<p class="eyebrow">${view.vendorName} · for ${view.clientName}</p>
<h1>${title}</h1>`;
}

function footer(view: ClientView): SafeHtml {
  const granted = view.authorization.status === "granted" ? html`<p>You granted the authorization on ${formatShortDate(view.authorization.at, view.timeZone)}.</p>` : null;
  return html`<footer>
${granted}
<p>Your responses are recorded with the date and time, your name and email address, and your device's IP address and browser details, as evidence of who responded.</p>
<p>This link is personal to you and expires on ${formatLongDate(view.expiresAt, view.timeZone)}. Record kept with Veradact.</p>
</footer>`;
}

// ---------------------------------------------------------------------------------------------
// Invalid / rate limited

export function renderInvalidLinkPage(): string {
  return document(
    "Link no longer valid",
    html`<h1>This link is no longer valid</h1>
<p>It may have expired or been withdrawn, or it may not have been copied completely.</p>
<p>If you still need to respond, ask the person who sent it to you for a new link.</p>`,
  );
}

export function renderErrorPage(): string {
  return document(
    "Something went wrong",
    html`<h1>Something went wrong</h1>
<p>Your last action may not have been recorded. Please go back and try again in a moment.</p>`,
  );
}

export function renderRateLimitedPage(): string {
  return document(
    "Too many requests",
    html`<h1>Too many requests</h1>
<p>This page was opened too many times in a short period. Please wait a few minutes and try again.</p>`,
  );
}

// ---------------------------------------------------------------------------------------------
// Authorization

function authorizationForm(view: ClientView, token: string, buttons: "both" | "grant"): SafeHtml {
  return html`<form method="post" action="${pageUrl(token)}">
<input type="hidden" name="action" value="authorize">
<input type="hidden" name="text_sha256" value="${view.authorizationTextSha256}">
<button class="button" type="submit" name="decision" value="grant">Grant authorization</button>
${buttons === "both" ? html`<button class="button secondary" type="submit" name="decision" value="decline">Decline</button>` : null}
</form>`;
}

export function renderAuthorizationPage(view: ClientView, token: string, opts: { notice?: Notice } = {}): string {
  const changed =
    view.authorization.status === "required" && view.authorization.reason === "text_version_changed"
      ? { tone: "info" as const, text: "The authorization text has changed since you last granted it. Please read it again." }
      : undefined;
  return document(
    `Authorization · ${view.engagementName}`,
    html`${header(view, "Before you review: your authorization")}
${noticeBlock(opts.notice ?? changed)}
<p>Hello ${view.contactName}. ${view.vendorName} asks you to confirm items recorded for <strong>${view.engagementName}</strong>. First, please read this authorization. Your decision is stored with this exact text.</p>
<div class="authorization" id="authorization-text">${view.authorizationText}</div>
${authorizationForm(view, token, "both")}
${footer(view)}`,
  );
}

export function renderDeclinedPage(view: ClientView, token: string): string {
  return document(
    `Authorization declined · ${view.engagementName}`,
    html`${header(view, "You declined the authorization")}
<div class="notice"><p>${view.vendorName} has been told. You cannot confirm or dispute items for ${view.engagementName} unless you grant the authorization below. You can come back to this link while it is valid.</p></div>
<div class="authorization" id="authorization-text">${view.authorizationText}</div>
${authorizationForm(view, token, "grant")}
${footer(view)}`,
  );
}

// ---------------------------------------------------------------------------------------------
// Items

function sourceLine(item: ClientViewItem, view: ClientView): SafeHtml {
  if (item.manual) return html`<p class="source">Entered manually by ${view.vendorName}, not quoted from a source · ${formatShortDate(item.occurredAt, view.timeZone)}</p>`;
  return html`${item.quotes.map((q) => {
    const where = [q.sourceType ? SOURCE_LABEL[q.sourceType] : "Source", q.sourceDate ? formatShortDate(q.sourceDate, view.timeZone) : null].filter(Boolean).join(" · ");
    if (q.state === "verified") return html`<blockquote><p>“${q.quote}”</p><p class="source">${where}</p></blockquote>`;
    const why = q.state === "redacted" ? "The source of this quote has been deleted." : "This quote is not available.";
    return html`<blockquote><p class="source">${why} ${where}</p></blockquote>`;
  })}`;
}

function diffBlock(item: ClientViewItem): SafeHtml | null {
  const prev = item.previouslyConfirmed;
  if (!prev) return null;
  const segments = prev.diff.map((s) => (s.op === "insert" ? html`<ins>${s.text}</ins>` : s.op === "delete" ? html`<del>${s.text}</del>` : html`${s.text}`));
  return html`<div class="diff"><p class="muted">Changed since version ${prev.version} was confirmed (<del>removed</del>, <ins>added</ins>):</p><p>${segments}</p></div>`;
}

const DECISION_TEXT = { confirmed: "Confirmed", disputed: "Disputed" } as const;

function itemCard(item: ClientViewItem, view: ClientView, values: FormValues | undefined, error: ClientFieldError | undefined): SafeHtml {
  const id = item.itemId;
  const existing = item.existingResponse;
  const decision: Decision = values?.decision ?? (existing ? (existing.decision === "confirmed" ? "confirm" : "dispute") : "skip");
  const comment = values?.comment ?? existing?.comment ?? "";
  const radio = (value: Decision, label: string, hint: string) =>
    html`<label class="choice"><input type="radio" name="d:${id}" value="${value}"${decision === value ? html` checked` : null}><span><strong>${label}</strong> <span class="muted">${hint}</span></span></label>`;
  const errorText =
    error === "comment_required"
      ? `Please say what is wrong, so ${view.vendorName} can correct it.`
      : error === "comment_too_long"
        ? "Please shorten your comment to 5000 characters or fewer."
        : error === "comment_invalid"
          ? "Please remove unusual characters from your comment."
          : null;
  return html`<section class="card${error ? " has-error" : ""}" id="item-${item.shortId}">
<p class="meta"><span class="kind">${KIND_LABEL[item.kind]}</span><span class="code">${item.shortId}</span><span class="muted">version ${item.version}</span></p>
<p class="statement">${item.statement}</p>
${diffBlock(item)}
${sourceLine(item, view)}
${existing ? html`<p class="muted">Your current response: <strong>${DECISION_TEXT[existing.decision]}</strong> on ${formatShortDate(existing.recordedAt, view.timeZone)}. You can change it below.</p>` : null}
<input type="hidden" name="v:${id}" value="${item.version}:${item.contentHash}">
<fieldset>
<legend>Your response to ${item.shortId}</legend>
${radio("confirm", "Confirm", "this is correct")}
${radio("dispute", "Dispute", "this is wrong or incomplete")}
${radio("skip", "Skip", "decide later")}
<label class="comment-label" for="c-${id}">What is right instead? (required to dispute)</label>
<textarea id="c-${id}" name="c:${id}" maxlength="5000" rows="3">${comment}</textarea>
${errorText ? html`<p class="field-error" id="e-${id}">${errorText}</p>` : null}
</fieldset>
</section>`;
}

function updatedSection(view: ClientView): SafeHtml | null {
  if (view.updatedItems.length === 0) return null;
  return html`<h2>Updated since this request</h2>
<p class="muted">${view.vendorName} changed these items after sending this request, so no action is possible here. You may receive a new request for the updated versions.</p>
${view.updatedItems.map(
  (item) => html`<section class="card updated" id="item-${item.shortId}">
<p class="meta"><span class="kind">${KIND_LABEL[item.kind]}</span><span class="code">${item.shortId}</span><span class="muted">version ${item.version}</span></p>
<p class="statement">${item.statement}</p>
<p class="source">Updated since this request — no action possible.</p>
</section>`,
)}`;
}

export interface ItemsPageOptions {
  submissionId: string;
  values?: Record<string, FormValues>;
  errors?: Record<string, ClientFieldError>;
  notice?: Notice;
}

export function renderItemsPage(view: ClientView, token: string, opts: ItemsPageOptions): string {
  const count = view.items.length;
  const errorCount = Object.keys(opts.errors ?? {}).length;
  const notice: Notice | undefined =
    errorCount > 0
      ? { tone: "error", text: `${plural(errorCount, "dispute needs", "disputes need")} a comment. Nothing was recorded yet.` }
      : opts.notice;
  const form =
    count === 0
      ? html`<div class="notice"><p>There is nothing to confirm on this link right now.</p></div>`
      : html`<form method="post" action="${pageUrl(token)}" novalidate>
<input type="hidden" name="submission_id" value="${opts.submissionId}">
${view.items.map((item) => itemCard(item, view, opts.values?.[item.itemId], opts.errors?.[item.itemId]))}
<div class="actions">
<button class="button" type="submit" name="action" value="submit">Submit responses</button>
<button class="button secondary" type="submit" name="action" value="confirm-all-review">Confirm all ${plural(count, "item", "items")}…</button>
</div>
</form>`;
  return document(
    `Confirm items · ${view.engagementName}`,
    html`${header(view, view.engagementName)}
${noticeBlock(notice)}
${count > 0 ? html`<p>Hello ${view.contactName}. ${view.vendorName} asks you to check ${plural(count, "item", "items")}. For each one, choose <strong>Confirm</strong> if it is correct, <strong>Dispute</strong> if it is wrong or incomplete (and say what is right), or <strong>Skip</strong> to decide later.</p>` : null}
${form}
${updatedSection(view)}
${footer(view)}`,
  );
}

// ---------------------------------------------------------------------------------------------
// Confirm all (interstitial)

export function renderConfirmAllPage(view: ClientView, token: string, submissionId: string): string {
  const count = view.items.length;
  if (count === 0) return renderItemsPage(view, token, { submissionId });
  return document(
    `Confirm all · ${view.engagementName}`,
    html`${header(view, `Confirm all ${plural(count, "item", "items")}?`)}
<p>You are about to confirm to ${view.vendorName} that every item below is correct. Please read the full list before you confirm.</p>
<ol class="list" id="confirm-all-list">
${view.items.map((item) => html`<li><span class="code">${item.shortId}</span> · ${KIND_LABEL[item.kind]}: ${item.statement}</li>`)}
</ol>
<form method="post" action="${pageUrl(token)}">
<input type="hidden" name="submission_id" value="${submissionId}">
${view.items.map(
  (item) => html`<input type="hidden" name="d:${item.itemId}" value="confirm">
<input type="hidden" name="v:${item.itemId}" value="${item.version}:${item.contentHash}">`,
)}
<button class="button" type="submit" name="action" value="submit">Confirm these ${plural(count, "item", "items")}</button>
</form>
<a class="button secondary" href="${itemsUrl(token)}">Back to the items</a>
${footer(view)}`,
  );
}

// ---------------------------------------------------------------------------------------------
// Receipt

export function renderReceiptPage(receipt: ClientReceipt, token: string, opts: { duplicate: boolean; emailSent: boolean }): string {
  const emailNotice: Notice = opts.duplicate
    ? { tone: "info", text: "This form had already been submitted, so nothing new was recorded. This is the receipt of that submission; a copy was emailed to you then." }
    : opts.emailSent
      ? { tone: "ok", text: "We have emailed a copy of this receipt to you. Keep it: it is your own record of what you responded." }
      : { tone: "info", text: "We could not email you a copy just now. Please keep this page or note the hashes below." };
  return document(
    `Receipt · ${receipt.engagementName}`,
    html`${header(receipt, "Your responses were recorded")}
<p>Recorded on ${formatDateTime(receipt.recordedAt, receipt.timeZone)} for <strong>${receipt.engagementName}</strong>.</p>
${noticeBlock(emailNotice)}
${receipt.items.map(
  (item) => html`<section class="card" id="receipt-${item.shortId}">
<p class="meta"><span class="kind">${KIND_LABEL[item.kind]}</span><span class="code">${item.shortId}</span><span class="decision ${item.decision}">${DECISION_TEXT[item.decision]}</span></p>
<p class="statement">${item.statement}</p>
<dl class="facts"><dt>Version</dt><dd>${item.version}</dd><dt>Content hash</dt><dd class="hash">${item.contentHash}</dd></dl>
</section>`,
)}
<h2>Ledger position after your responses</h2>
<dl class="facts" id="ledger-head"><dt>Entry</dt><dd>${receipt.head.seq}</dd><dt>Ledger hash</dt><dd class="hash">${receipt.head.hash}</dd></dl>
<p class="muted">These hashes identify exactly what you responded to. If the record were ever changed, they would no longer match your copy.</p>
<a class="button secondary" href="${itemsUrl(token)}">Back to the items</a>`,
  );
}
