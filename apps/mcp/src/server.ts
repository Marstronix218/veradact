// Remote MCP server (ARCHITECTURE §11, D-005): plain Node `http`, the SDK's Streamable HTTP
// transport in stateless mode (a fresh McpServer + transport per POST), bearer API tokens, and
// Postgres fixed-window rate limits per IP and per token. Logs carry ids, enums and counts only.
import { existsSync, realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { checkRateLimit, log, logError, logId, resolveApiToken } from "@veradact/core";
import { createDb, type Db } from "@veradact/db";
import { createVeradactMcpServer } from "./tools";

export interface RateLimits {
  /** Requests per minute per API token (counted after authentication). */
  perTokenPerMinute: number;
  /** Requests per minute per client IP (counted before authentication). */
  perIpPerMinute: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = { perTokenPerMinute: 60, perIpPerMinute: 120 };
export const MAX_BODY_BYTES = 1024 * 1024;
const WINDOW_SECONDS = 60;

export interface McpHttpServerOptions {
  /** App-role database (RLS enforced). */
  db: Db;
  clock?: () => Date;
  rateLimits?: Partial<RateLimits>;
  maxBodyBytes?: number;
}

const UNAUTHORIZED_MESSAGE =
  "Unauthorized: send a Veradact API token as \"Authorization: Bearer vdt_...\". Create one in the Veradact web app under Settings → API tokens.";

function sendError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The raw bearer token, or null when the header is missing or not a bearer credential. */
function bearerToken(req: IncomingMessage): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header(req, "authorization") ?? "");
  return match?.[1] ?? null;
}

/**
 * Client IP: the first `x-forwarded-for` entry (set by the proxy in front of the server), else
 * `x-real-ip`, else the socket address — the same rule as the web app. Deploy behind a proxy that
 * overwrites these headers. Used only as a rate-limit key (hashed), never logged.
 */
function clientIp(req: IncomingMessage): string {
  const forwarded = header(req, "x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return header(req, "x-real-ip")?.trim() || req.socket.remoteAddress || "unknown";
}

/** An `http.Server` (not listening) serving `/mcp` and `/healthz`. */
export function createMcpHttpServer(options: McpHttpServerOptions): Server {
  const { db } = options;
  const clock = options.clock ?? (() => new Date());
  const limits: RateLimits = { ...DEFAULT_RATE_LIMITS, ...options.rateLimits };
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    if (req.method !== "POST") {
      // Stateless mode: no SSE stream to GET and no session to DELETE.
      sendError(res, 405, "Method not allowed: this server is stateless; send JSON-RPC requests with POST.", { allow: "POST" });
      return;
    }
    const ipLimit = await checkRateLimit(db, { scope: "mcp_ip", id: clientIp(req), limit: limits.perIpPerMinute, windowSeconds: WINDOW_SECONDS, now: clock() });
    if (!ipLimit.allowed) {
      log.warn("mcp.rate_limited", { scope: "mcp_ip" as const, retryAfterSeconds: ipLimit.retryAfterSeconds });
      sendError(res, 429, "Too many requests. Try again later.", { "retry-after": String(ipLimit.retryAfterSeconds) });
      return;
    }

    const raw = bearerToken(req);
    const auth = await resolveApiToken(db, raw, clock);
    if (!auth) {
      log.info("mcp.unauthorized", { tokenPresent: raw !== null });
      const challenge = raw === null ? 'Bearer realm="veradact"' : 'Bearer realm="veradact", error="invalid_token"';
      sendError(res, 401, UNAUTHORIZED_MESSAGE, { "www-authenticate": challenge });
      return;
    }
    const ids = { orgId: logId(auth.orgId), apiTokenId: logId(auth.apiTokenId) };

    const tokenLimit = await checkRateLimit(db, { scope: "mcp_token", id: auth.apiTokenId, limit: limits.perTokenPerMinute, windowSeconds: WINDOW_SECONDS, now: clock() });
    if (!tokenLimit.allowed) {
      log.warn("mcp.rate_limited", { ...ids, scope: "mcp_token" as const, retryAfterSeconds: tokenLimit.retryAfterSeconds });
      sendError(res, 429, "Too many requests for this API token. Try again later.", { "retry-after": String(tokenLimit.retryAfterSeconds) });
      return;
    }

    const server = createVeradactMcpServer({ db, clock, auth });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: maxBodyBytes });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
    log.info("mcp.request", { ...ids, status: res.statusCode, durationMs: Date.now() - started });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/healthz") {
      if (req.method === "GET" || req.method === "HEAD") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(req.method === "HEAD" ? undefined : JSON.stringify({ ok: true }));
      } else sendError(res, 405, "Method not allowed.", { allow: "GET, HEAD" });
      return;
    }
    if (path !== "/mcp") {
      sendError(res, 404, "Not found. The MCP endpoint is /mcp.");
      return;
    }
    await handleMcp(req, res);
  }

  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      logError("mcp.request_failed", error);
      if (!res.headersSent) sendError(res, 500, "Internal server error.");
      else res.end();
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Entry point (`pnpm --filter @veradact/mcp dev|start`). Importing this module starts nothing.

function loadRootEnv(): void {
  const path = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (existsSync(path)) process.loadEnvFile(path);
}

function main(): void {
  loadRootEnv();
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is not set (see .env.example)");
  const port = Number(process.env.MCP_PORT ?? "3001");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MCP_PORT must be a port number");

  const handle = createDb(databaseUrl, { max: 10 });
  const server = createMcpHttpServer({ db: handle.db });
  server.listen(port, () => log.info("mcp.listening", { port }));
  const shutdown = () => {
    server.close(() => void handle.close());
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const entry = process.argv[1];
if (entry && existsSync(entry) && pathToFileURL(realpathSync(entry)).href === import.meta.url) main();
