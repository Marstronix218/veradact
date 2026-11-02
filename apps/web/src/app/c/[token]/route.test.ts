// The client POST handler's answer when `clientAuthorize` reports a race (the request revoked or
// expired, or the contact erased, after the link was resolved): re-check the link and show the
// 410 page when it died, never a 500. The service side is covered in confirmation-flow.int.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientView } from "@veradact/core";
import type { NextRequest } from "next/server";

const core = vi.hoisted(() => ({
  checkClientPageRateLimit: vi.fn(),
  resolveClientLink: vi.fn(),
  recordLinkInteraction: vi.fn(),
  loadClientView: vi.fn(),
  clientAuthorize: vi.fn(),
}));

vi.mock("@veradact/core", async (importOriginal) => ({ ...(await importOriginal<typeof import("@veradact/core")>()), ...core }));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/email", () => ({ getEmailProvider: () => ({ send: vi.fn() }) }));
vi.mock("@/lib/env", () => ({ appUrl: () => "http://veradact.test" }));
vi.mock("@/client/pages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/pages")>()),
  renderAuthorizationPage: (_view: ClientView, _token: string, opts: { notice?: { text: string } } = {}) => `authorization page|${opts.notice?.text ?? ""}`,
}));

const { POST } = await import("./route");
const { renderInvalidLinkPage } = await import("@/client/pages");

const TOKEN = "v1.synthetic-token";
const LINK = { orgId: "o", engagementId: "e", requestId: "r", contactId: "c", linkId: "l" };
const REQUIRED_VIEW = { link: LINK, authorization: { status: "required", reason: "never_authorized" } } as unknown as ClientView;

function authorizePost(): NextRequest {
  return new Request(`http://veradact.test/c/${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
    body: "action=authorize&decision=grant&text_sha256=" + "b".repeat(64),
  }) as unknown as NextRequest;
}

const params = { params: Promise.resolve({ token: TOKEN }) };

beforeEach(() => {
  vi.clearAllMocks();
  core.checkClientPageRateLimit.mockResolvedValue({ allowed: true });
  core.recordLinkInteraction.mockResolvedValue(undefined);
  core.loadClientView.mockResolvedValue(REQUIRED_VIEW);
  core.clientAuthorize.mockResolvedValue({ status: "stale" });
});

describe("POST /c/[token] action=authorize after a race", () => {
  it("re-resolves the link and answers 410 when it is no longer valid", async () => {
    core.resolveClientLink.mockResolvedValueOnce({ ok: true, ctx: LINK }).mockResolvedValueOnce({ ok: false });
    const res = await POST(authorizePost(), params);
    expect(res.status).toBe(410);
    expect(await res.text()).toBe(renderInvalidLinkPage());
    expect(core.resolveClientLink).toHaveBeenCalledTimes(2);
  });

  it("shows the page again with a notice when the link still resolves", async () => {
    core.resolveClientLink.mockResolvedValue({ ok: true, ctx: LINK });
    const res = await POST(authorizePost(), params);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("authorization page|Something changed while you were reading, so nothing was recorded. Please try again.");
  });
});
