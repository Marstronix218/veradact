import { describe, expect, it } from "vitest";
import type { ClientReceipt, ClientView, ClientViewItem } from "@veradact/core";
import { parseClientForm } from "./form";
import {
  renderAuthorizationPage,
  renderConfirmAllPage,
  renderDeclinedPage,
  renderInvalidLinkPage,
  renderItemsPage,
  renderReceiptPage,
} from "./pages";
import { CLIENT_CSP, CLIENT_SECURITY_HEADERS, htmlResponse } from "./respond";

const EVIL = `<script>alert(1)</script>"'`;
const token = "v1.3b1f6c1e-1d2a-4c3b-9a8e-7f6d5c4b3a21.1790000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function item(overrides: Partial<ClientViewItem> = {}): ClientViewItem {
  return {
    itemId: "11111111-1111-4111-8111-111111111111",
    shortId: "HALV-R1",
    kind: "requirement",
    version: 2,
    contentHash: "a".repeat(64),
    statement: `Refresh every two minutes ${EVIL}`,
    actionable: true,
    manual: false,
    quotes: [{ state: "verified", quote: `It must refresh ${EVIL}`, sourceType: "human_notes", sourceDate: new Date("2026-02-20T14:00:00Z") }],
    occurredAt: new Date("2026-02-20T14:00:00Z"),
    previouslyConfirmed: {
      version: 1,
      statement: "Refresh every five minutes",
      diff: [
        { op: "equal", text: "Refresh every " },
        { op: "delete", text: "five" },
        { op: "insert", text: `two ${EVIL}` },
        { op: "equal", text: " minutes" },
      ],
    },
    existingResponse: null,
    ...overrides,
  };
}

function view(overrides: Partial<ClientView> = {}): ClientView {
  return {
    link: { orgId: "o", engagementId: "e", requestId: "r", contactId: "c", linkId: "l" },
    engagementName: `Dispatch ${EVIL}`,
    clientName: "Halvorsen Freight",
    timeZone: "America/New_York",
    vendorName: `Quillfield ${EVIL}`,
    contactName: `Ada ${EVIL}`,
    expiresAt: new Date("2026-11-16T17:00:00Z"),
    authorization: { status: "granted", at: new Date("2026-11-02T15:00:00Z") },
    authorizationText: `I authorize ${EVIL}\n- line two`,
    authorizationTextVersion: "auth.v1",
    authorizationTextSha256: "b".repeat(64),
    items: [
      item(),
      item({ itemId: "22222222-2222-4222-8222-222222222222", shortId: "HALV-D1", kind: "decision", version: 1, manual: true, quotes: [], previouslyConfirmed: null }),
    ],
    updatedItems: [item({ itemId: "33333333-3333-4333-8333-333333333333", shortId: "HALV-A1", kind: "assumption", actionable: false })],
    ...overrides,
  };
}

function expectNoScriptAndEscaped(page: string) {
  expect(page).not.toMatch(/<script/i);
  expect(page).not.toMatch(/\son\w+=/i);
  expect(page).not.toMatch(/https?:\/\//);
  expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;");
  expect(page).toContain('<link rel="stylesheet" href="/c/static/client.css">');
  expect(page).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
}

describe("client pages", () => {
  it("items page: escapes all content, shows quotes, manual items, diff and the three choices defaulting to Skip", () => {
    const page = renderItemsPage(view(), token, { submissionId: "44444444-4444-4444-8444-444444444444" });
    expectNoScriptAndEscaped(page);
    expect(page).toContain('<input type="hidden" name="submission_id" value="44444444-4444-4444-8444-444444444444">');
    expect(page).toContain("<del>five</del><ins>two &lt;script&gt;");
    expect(page).toContain("Meeting notes · Feb 20, 2026");
    expect(page).toContain("Entered manually by Quillfield");
    expect(page).toContain('name="v:11111111-1111-4111-8111-111111111111" value="2:' + "a".repeat(64) + '"');
    expect(page).toMatch(/name="d:11111111-1111-4111-8111-111111111111" value="skip" checked/);
    expect(page).not.toMatch(/value="confirm" checked/);
    expect(page).toContain('name="action" value="submit">Submit responses</button>');
    expect(page).toContain('value="confirm-all-review">Confirm all 2 items…</button>');
    expect(page).toContain("Updated since this request — no action possible.");
    // The updated item has no inputs.
    expect(page).not.toContain('name="d:33333333-3333-4333-8333-333333333333"');
    expect(page).toContain(`action="/c/${token}"`);
  });

  it("items page: preselects existing responses and re-shows entered values with an inline error", () => {
    const existing = view({
      items: [item({ existingResponse: { decision: "disputed", comment: `Was five ${EVIL}`, recordedAt: new Date("2026-11-02T15:00:00Z") } })],
    });
    const page = renderItemsPage(existing, token, { submissionId: "s" });
    expect(page).toMatch(/value="dispute" checked/);
    expect(page).toContain("Was five &lt;script&gt;");
    expect(page).toContain("Your current response: <strong>Disputed</strong>");

    const rejected = renderItemsPage(view(), token, {
      submissionId: "s",
      values: { "11111111-1111-4111-8111-111111111111": { decision: "dispute", comment: "" } },
      errors: { "11111111-1111-4111-8111-111111111111": "comment_required" },
    });
    expect(rejected).toMatch(/value="dispute" checked/);
    expect(rejected).toContain('class="card has-error"');
    expect(rejected).toContain("Please say what is wrong");
    expect(rejected).toContain("1 dispute needs a comment. Nothing was recorded yet.");
  });

  it("authorization page shows the exact text with Grant and Decline; declined page offers Grant only", () => {
    const required = view({ authorization: { status: "required", reason: "none" } });
    const page = renderAuthorizationPage(required, token);
    expectNoScriptAndEscaped(page);
    expect(page).toContain("I authorize &lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;\n- line two</div>");
    expect(page).toContain(`<input type="hidden" name="text_sha256" value="${"b".repeat(64)}">`);
    expect(page).toContain('value="grant">Grant authorization</button>');
    expect(page).toContain('value="decline">Decline</button>');
    expect(renderAuthorizationPage(view({ authorization: { status: "required", reason: "text_version_changed" } }), token)).toContain(
      "The authorization text has changed",
    );
    const declined = renderDeclinedPage(view({ authorization: { status: "declined", at: new Date() } }), token);
    expect(declined).toContain("You declined the authorization");
    expect(declined).not.toContain('value="decline"');
  });

  it("confirm-all interstitial lists every item and posts confirm for each", () => {
    const page = renderConfirmAllPage(view(), token, "55555555-5555-4555-8555-555555555555");
    expectNoScriptAndEscaped(page);
    expect(page).toContain("Confirm all 2 items?");
    expect(page.match(/<li>/g)).toHaveLength(2);
    expect(page).toContain('<input type="hidden" name="d:22222222-2222-4222-8222-222222222222" value="confirm">');
    expect(page).toContain('value="submit">Confirm these 2 items</button>');
    expect(page).toContain(`href="/c/${token}?step=items"`);
  });

  it("receipt shows each version hash and the ledger head", () => {
    const receipt: ClientReceipt = {
      submissionId: "s",
      engagementName: `Dispatch ${EVIL}`,
      clientName: "Halvorsen Freight",
      vendorName: "Quillfield",
      contactName: "Ada",
      timeZone: "America/New_York",
      recordedAt: new Date("2026-11-02T15:04:00Z"),
      items: [{ itemId: "x", shortId: "HALV-R1", kind: "requirement", statement: "S", decision: "disputed", version: 2, contentHash: "c".repeat(64) }],
      head: { seq: 17, hash: "d".repeat(64) },
    };
    const page = renderReceiptPage(receipt, token, { duplicate: false, emailSent: true });
    expectNoScriptAndEscaped(page);
    expect(page).toContain('<span class="decision disputed">Disputed</span>');
    expect(page).toContain(`<dd class="hash">${"c".repeat(64)}</dd>`);
    expect(page).toContain(`<dd>17</dd><dt>Ledger hash</dt><dd class="hash">${"d".repeat(64)}</dd>`);
    expect(page).toContain("We have emailed a copy of this receipt to you.");
    expect(renderReceiptPage(receipt, token, { duplicate: true, emailSent: false })).toContain("nothing new was recorded");
  });

  it("invalid page has no details and responses carry the strict headers", async () => {
    expect(renderInvalidLinkPage()).toContain("This link is no longer valid");
    const response = htmlResponse("<p>x</p>", 410);
    expect(response.status).toBe(410);
    expect(response.headers.get("content-security-policy")).toBe(CLIENT_CSP);
    expect(CLIENT_CSP).toBe("default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    for (const [key, value] of Object.entries(CLIENT_SECURITY_HEADERS)) expect(response.headers.get(key)).toBe(value);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("<p>x</p>");
  });
});

describe("parseClientForm", () => {
  const v = view();
  const [a, d] = v.items as [ClientViewItem, ClientViewItem];
  const bind = (i: ClientViewItem) => `${i.version}:${i.contentHash}`;

  it("reads decisions, comments and bindings; missing or unknown decisions are skips", () => {
    const form = new FormData();
    form.set(`d:${a.itemId}`, "dispute");
    form.set(`c:${a.itemId}`, "Not right");
    form.set(`v:${a.itemId}`, bind(a));
    form.set(`d:${d.itemId}`, "bogus");
    form.set(`v:${d.itemId}`, bind(d));
    const parsed = parseClientForm(form, v);
    expect(parsed.stale).toBe(false);
    expect(parsed.responses).toEqual([{ itemId: a.itemId, version: 2, contentHash: a.contentHash, decision: "dispute", comment: "Not right" }]);
    expect(parsed.values[d.itemId]).toEqual({ decision: "skip", comment: "" });
  });

  it("is stale when a binding is missing or different, or an updated item is answered", () => {
    const missing = new FormData();
    missing.set(`d:${a.itemId}`, "confirm");
    expect(parseClientForm(missing, v).stale).toBe(true);

    const other = new FormData();
    other.set(`d:${a.itemId}`, "confirm");
    other.set(`v:${a.itemId}`, `1:${a.contentHash}`);
    expect(parseClientForm(other, v)).toMatchObject({ stale: true, responses: [] });

    const updated = new FormData();
    updated.set(`d:${v.updatedItems[0]!.itemId}`, "confirm");
    expect(parseClientForm(updated, v).stale).toBe(true);
  });
});
