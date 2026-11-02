// /c/<token> — the client confirmation page (ARCHITECTURE §8.3). Route handlers, not React: GET
// renders, POST handles `action=authorize|submit|confirm-all-review`. Every invalid, expired or
// revoked link gets the same 410 page; rate limits are per IP and per link. Tokens, IPs and names
// are never logged (the dev request log skips /c/, next.config.ts).
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  checkClientPageRateLimit,
  clientAuthorize,
  clientSubmit,
  loadClientView,
  logError,
  parseLinkToken,
  recordLinkInteraction,
  recordLinkOpen,
  resolveClientLink,
  type ClientLinkContext,
  type ClientView,
} from "@veradact/core";
import { parseClientForm } from "@/client/form";
import {
  renderAuthorizationPage,
  renderConfirmAllPage,
  renderDeclinedPage,
  renderErrorPage,
  renderInvalidLinkPage,
  renderItemsPage,
  renderRateLimitedPage,
  renderReceiptPage,
  type Notice,
} from "@/client/pages";
import { htmlResponse, seeOther } from "@/client/respond";
import { clock } from "@/lib/clock";
import { getDb } from "@/lib/db";
import { getEmailProvider } from "@/lib/email";
import { appUrl } from "@/lib/env";
import { clientIpFrom, userAgentFrom } from "@/lib/request";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ token: string }> };

const invalid = () => htmlResponse(renderInvalidLinkPage(), 410);

/** Rate limit, then resolve the link. Returns the link context or the response to send. */
async function open(request: NextRequest, token: string): Promise<{ link: ClientLinkContext } | { response: Response }> {
  const db = getDb();
  const limit = await checkClientPageRateLimit(db, {
    ip: clientIpFrom(request.headers),
    linkKey: parseLinkToken(token)?.linkId ?? token.slice(0, 200),
    now: clock(),
  });
  if (!limit.allowed) {
    return { response: htmlResponse(renderRateLimitedPage(), 429, { "Retry-After": String(limit.retryAfterSeconds) }) };
  }
  const resolved = await resolveClientLink({ db, token, clock });
  return resolved.ok ? { link: resolved.ctx } : { response: invalid() };
}

function pageFor(view: ClientView, token: string, notice?: Notice): Response {
  switch (view.authorization.status) {
    case "granted":
      return htmlResponse(renderItemsPage(view, token, { submissionId: randomUUID(), ...(notice ? { notice } : {}) }));
    case "declined":
      return htmlResponse(renderDeclinedPage(view, token));
    default:
      return htmlResponse(renderAuthorizationPage(view, token, notice ? { notice } : {}));
  }
}

export async function GET(request: NextRequest, { params }: Params): Promise<Response> {
  const { token } = await params;
  try {
    const opened = await open(request, token);
    if ("response" in opened) return opened.response;
    const db = getDb();
    // Redirects after an action carry ?step=…; only a fresh visit counts as an open.
    if (!request.nextUrl.searchParams.has("step")) await recordLinkOpen({ db, link: opened.link, clock });
    return pageFor(await loadClientView(db, opened.link, { clock }), token);
  } catch (error) {
    logError("client_page.get_failed", error);
    return htmlResponse(renderErrorPage(), 500);
  }
}

export async function POST(request: NextRequest, { params }: Params): Promise<Response> {
  const { token } = await params;
  try {
    const opened = await open(request, token);
    if ("response" in opened) return opened.response;
    const { link } = opened;
    const db = getDb();
    await recordLinkInteraction({ db, link, clock });

    const form = await request.formData();
    const action = form.get("action");
    const evidence = { ip: nullIfUnknown(clientIpFrom(request.headers)), userAgent: userAgentFrom(request.headers) };
    const view = await loadClientView(db, link, { clock });

    if (action === "authorize") {
      const raw = form.get("decision");
      const decision = raw === "grant" ? "granted" : raw === "decline" ? "declined" : null;
      if (!decision) return pageFor(view, token);
      const shown = form.get("text_sha256");
      const result = await clientAuthorize({
        db,
        link,
        clock,
        decision,
        shownTextSha256: typeof shown === "string" ? shown : null,
        evidence,
        emailProvider: getEmailProvider(),
        appUrl: appUrl(),
      });
      if (result.status === "text_changed") {
        return htmlResponse(
          renderAuthorizationPage(await loadClientView(db, link, { clock }), token, {
            notice: { tone: "info", text: "The authorization text was updated while you were reading it. Please read it again." },
          }),
        );
      }
      return seeOther(`/c/${token}?step=${decision === "granted" ? "items" : "declined"}`);
    }

    if (view.authorization.status !== "granted") return pageFor(view, token);
    const submissionId = typeof form.get("submission_id") === "string" ? String(form.get("submission_id")) : randomUUID();

    if (action === "confirm-all-review") return htmlResponse(renderConfirmAllPage(view, token, submissionId));
    if (action !== "submit") return pageFor(view, token);

    const parsed = parseClientForm(form, view);
    const stale: Notice = { tone: "error", text: "Some items changed while you were reviewing them, so nothing was recorded. Please check them again." };
    if (parsed.stale) return htmlResponse(renderItemsPage(view, token, { submissionId: randomUUID(), notice: stale }), 409);

    const result = await clientSubmit({
      db,
      link,
      clock,
      submissionId,
      responses: parsed.responses,
      evidence,
      emailProvider: getEmailProvider(),
      appUrl: appUrl(),
    });
    switch (result.status) {
      case "recorded":
        return htmlResponse(renderReceiptPage(result.receipt, token, { duplicate: result.duplicate, emailSent: result.receiptEmailSent }));
      case "invalid":
        return htmlResponse(renderItemsPage(view, token, { submissionId, values: parsed.values, errors: result.errors }), 422);
      case "nothing_to_record":
        return htmlResponse(
          renderItemsPage(view, token, {
            submissionId,
            values: parsed.values,
            notice: { tone: "info", text: "Nothing to record: every item is skipped or already has that response. Choose Confirm or Dispute for at least one item." },
          }),
        );
      case "authorization_required":
        return pageFor(await loadClientView(db, link, { clock }), token);
      case "stale": {
        const fresh = await loadClientView(db, link, { clock });
        return htmlResponse(renderItemsPage(fresh, token, { submissionId: randomUUID(), notice: stale }), 409);
      }
    }
  } catch (error) {
    logError("client_page.post_failed", error);
    return htmlResponse(renderErrorPage(), 500);
  }
}

function nullIfUnknown(ip: string): string | null {
  return ip === "unknown" ? null : ip;
}
