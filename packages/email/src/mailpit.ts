/**
 * Test helpers for Mailpit (the dev SMTP sink, web/API on :54332). Import from
 * `@veradact/email/mailpit` in Playwright and integration tests only; app code never needs it.
 *
 * Error messages here never include recipients, subjects or bodies.
 */

export interface MailpitOptions {
  /** Mailpit web/API root. Default: `$MAILPIT_URL`, else `http://localhost:54332`. */
  baseUrl?: string;
}

export interface MailpitLatestOptions extends MailpitOptions {
  /** How long to wait for a message to arrive. Default 10 000 ms. */
  timeoutMs?: number;
  /** Delay between polls. Default 200 ms. */
  pollIntervalMs?: number;
  /**
   * Ignore messages Mailpit received before this instant. Compared with Mailpit's own
   * timestamps, so it assumes the clocks agree; a unique recipient address per test is the
   * more robust way to isolate messages.
   */
  since?: Date | number;
}

export interface MailpitMessage {
  subject: string;
  text: string;
  /** Empty string when the message has no HTML part. */
  html: string;
}

const DEFAULT_BASE_URL = "http://localhost:54332";
const REQUEST_TIMEOUT_MS = 5_000;

function resolveBaseUrl(options: MailpitOptions): string {
  return (options.baseUrl || process.env.MAILPIT_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Mailpit answered, but not with success: retrying will not help. */
class MailpitHttpError extends Error {}

async function mailpitRequest(
  baseUrl: string,
  path: string,
  init?: { method?: string },
): Promise<Response> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const endpoint = `${init?.method ?? "GET"} ${path.split("?")[0]}`;
    throw new MailpitHttpError(`Mailpit ${endpoint} returned HTTP ${res.status}`);
  }
  return res;
}

async function mailpitJson(baseUrl: string, path: string): Promise<unknown> {
  return (await mailpitRequest(baseUrl, path)).json();
}

interface Candidate {
  id: string;
  created: number;
}

/** Messages in a search response addressed (exactly, case-insensitively) to `address`. */
function candidatesFrom(body: unknown, address: string, since: number): Candidate[] {
  const wanted = address.toLowerCase();
  const messages = isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
  const out: Candidate[] = [];
  for (const m of messages) {
    if (!isRecord(m) || typeof m.ID !== "string" || typeof m.Created !== "string") continue;
    const created = Date.parse(m.Created);
    if (Number.isNaN(created) || created < since) continue;
    const to = Array.isArray(m.To) ? m.To : [];
    const addressed = to.some(
      (t) => isRecord(t) && typeof t.Address === "string" && t.Address.toLowerCase() === wanted,
    );
    if (addressed) out.push({ id: m.ID, created });
  }
  return out.sort((a, b) => b.created - a.created);
}

/** True when the Mailpit API answers. Lets integration tests skip with a clear reason. */
export async function isMailpitReachable(options: MailpitOptions = {}): Promise<boolean> {
  try {
    await mailpitJson(resolveBaseUrl(options), "/api/v1/info");
    return true;
  } catch {
    return false;
  }
}

/**
 * Polls Mailpit until a message addressed to `address` exists and returns the newest one.
 * Throws when none arrives within `timeoutMs`.
 */
export async function mailpitLatestTo(
  address: string,
  options: MailpitLatestOptions = {},
): Promise<MailpitMessage> {
  const baseUrl = resolveBaseUrl(options);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollIntervalMs = options.pollIntervalMs ?? 200;
  const since = options.since === undefined ? 0 : Number(options.since);
  // `to:` is a substring match in Mailpit, so results are re-filtered for an exact address.
  const query = encodeURIComponent(`to:"${address.replace(/"/g, "")}"`);
  const deadline = Date.now() + timeoutMs;

  let reachable = false;
  for (;;) {
    try {
      const found = candidatesFrom(
        await mailpitJson(baseUrl, `/api/v1/search?query=${query}&limit=50`),
        address,
        since,
      )[0];
      reachable = true;
      if (found) {
        const body = await mailpitJson(baseUrl, `/api/v1/message/${encodeURIComponent(found.id)}`);
        if (isRecord(body)) {
          return {
            subject: typeof body.Subject === "string" ? body.Subject : "",
            text: typeof body.Text === "string" ? body.Text : "",
            html: typeof body.HTML === "string" ? body.HTML : "",
          };
        }
      }
    } catch (err) {
      // An HTTP error from a reachable Mailpit is a real failure; network errors are retried.
      if (err instanceof MailpitHttpError) throw err;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(
    reachable
      ? `No matching message reached Mailpit within ${timeoutMs} ms`
      : `Mailpit is unreachable at ${baseUrl} (waited ${timeoutMs} ms); is \`pnpm db:up\` running?`,
  );
}

/**
 * Deletes every message in Mailpit. The mailbox is shared by all tests, so call this only
 * from serial e2e setup, never from tests that may run alongside others.
 */
export async function mailpitClear(options: MailpitOptions = {}): Promise<void> {
  // Mailpit answers DELETE with the plain text "ok", not JSON.
  const res = await mailpitRequest(resolveBaseUrl(options), "/api/v1/messages", { method: "DELETE" });
  await res.text();
}

/**
 * First absolute http(s) URL in `text` whose path (plus query) starts with `pathPrefix`,
 * e.g. `/c/` or `/auth/verify`. Throws when there is none; the message never quotes `text`
 * because it carries the link token.
 */
export function extractFirstLink(text: string, pathPrefix: string): string {
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
    // Prose punctuation after a link is not part of it (tokens never end in these).
    const candidate = match[0].replace(/[.,;:!?)\]}]+$/, "");
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (`${url.pathname}${url.search}`.startsWith(pathPrefix)) return candidate;
  }
  throw new Error(`No link starting with ${pathPrefix} found in the message text`);
}
