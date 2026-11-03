// The MCP endpoint as a fetch-style handler (ARCHITECTURE §11, D-005): the SDK's Streamable HTTP
// transport in stateless mode (a fresh McpServer + transport per POST), bearer API tokens, and
// Postgres fixed-window rate limits per IP and per token. Shared by the standalone Node server
// (server.ts) and the web app's `/mcp` route, which serves it on serverless hosts (D-065). Logs
// carry ids, enums and counts only.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { checkRateLimit, log, logError, logId, resolveApiToken } from "@veradact/core";
import type { Db } from "@veradact/db";
import { createVeradactMcpServer } from "./tools";

export interface RateLimits {
  /** Requests per minute per API token (counted after authentication). */
  perTokenPerMinute: number;
  /** Requests per minute per client IP (counted before authentication). */
  perIpPerMinute: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = { perTokenPerMinute: 60, perIpPerMinute: 120 };
export const MAX_BODY_BYTES = 1024 * 1024;
/** Longest a request may take. The SDK never answers some requests (a batch that cancels its own call). */
export const REQUEST_TIMEOUT_MS = 25_000;
const WINDOW_SECONDS = 60;

export interface McpHandlerOptions {
  /** App-role database (RLS enforced). */
  db: Db;
  clock?: () => Date;
  rateLimits?: Partial<RateLimits>;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
}

/**
 * Answers one request to the MCP endpoint. `clientIp` is the caller's address as the host's
 * trusted-proxy rule resolved it; it is used only as a rate-limit key (hashed), never logged.
 */
export type McpHandler = (request: Request, clientIp: string) => Promise<Response>;

const UNAUTHORIZED_MESSAGE =
  "Unauthorized: send a Veradact API token as \"Authorization: Bearer vdt_...\". Create one in the Veradact web app under Settings → API tokens.";

/** A JSON-RPC error response, as the SDK transport writes them. */
export function mcpErrorResponse(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

/** 405 for anything but POST: stateless mode has no SSE stream to GET and no session to DELETE. */
export function mcpMethodNotAllowed(): Response {
  return mcpErrorResponse(405, "Method not allowed: this server is stateless; send JSON-RPC requests with POST.", { allow: "POST" });
}

/** Resolves with null once `signal` aborts. */
function whenAborted(signal: AbortSignal): Promise<null> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(null);
    else signal.addEventListener("abort", () => resolve(null), { once: true });
  });
}

/** The raw bearer token, or null when the header is missing or not a bearer credential. */
function bearerToken(request: Request): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

export function createMcpHandler(options: McpHandlerOptions): McpHandler {
  const { db } = options;
  const clock = options.clock ?? (() => new Date());
  const limits: RateLimits = { ...DEFAULT_RATE_LIMITS, ...options.rateLimits };
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  async function handle(request: Request, clientIp: string): Promise<Response> {
    const started = Date.now();
    if (request.method !== "POST") return mcpMethodNotAllowed();
    const ipLimit = await checkRateLimit(db, { scope: "mcp_ip", id: clientIp, limit: limits.perIpPerMinute, windowSeconds: WINDOW_SECONDS, now: clock() });
    if (!ipLimit.allowed) {
      log.warn("mcp.rate_limited", { scope: "mcp_ip" as const, retryAfterSeconds: ipLimit.retryAfterSeconds });
      return mcpErrorResponse(429, "Too many requests. Try again later.", { "retry-after": String(ipLimit.retryAfterSeconds) });
    }

    const raw = bearerToken(request);
    const auth = await resolveApiToken(db, raw, clock);
    if (!auth) {
      log.info("mcp.unauthorized", { tokenPresent: raw !== null });
      const challenge = raw === null ? 'Bearer realm="veradact"' : 'Bearer realm="veradact", error="invalid_token"';
      return mcpErrorResponse(401, UNAUTHORIZED_MESSAGE, { "www-authenticate": challenge });
    }
    const ids = { orgId: logId(auth.orgId), apiTokenId: logId(auth.apiTokenId) };

    const tokenLimit = await checkRateLimit(db, { scope: "mcp_token", id: auth.apiTokenId, limit: limits.perTokenPerMinute, windowSeconds: WINDOW_SECONDS, now: clock() });
    if (!tokenLimit.allowed) {
      log.warn("mcp.rate_limited", { ...ids, scope: "mcp_token" as const, retryAfterSeconds: tokenLimit.retryAfterSeconds });
      return mcpErrorResponse(429, "Too many requests for this API token. Try again later.", { "retry-after": String(tokenLimit.retryAfterSeconds) });
    }

    const server = createVeradactMcpServer({ db, clock, auth });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: maxBodyBytes });
    try {
      await server.connect(transport);
      // JSON response mode: resolves once every response to the request is in the body, or never
      // (a cancelled call gets no response), so the deadline and a client disconnect end it too.
      const deadline = AbortSignal.any([request.signal, AbortSignal.timeout(requestTimeoutMs)]);
      const response = await Promise.race([transport.handleRequest(request), whenAborted(deadline)]);
      if (!response) {
        log.warn("mcp.request_timeout", { ...ids, durationMs: Date.now() - started });
        return mcpErrorResponse(504, "The request did not finish in time.");
      }
      log.info("mcp.request", { ...ids, status: response.status, durationMs: Date.now() - started });
      return response;
    } finally {
      await transport.close();
      await server.close();
    }
  }

  return async (request, clientIp) => {
    try {
      return await handle(request, clientIp);
    } catch (error) {
      logError("mcp.request_failed", error);
      return mcpErrorResponse(500, "Internal server error.");
    }
  };
}
