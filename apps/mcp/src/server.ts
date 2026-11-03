// Remote MCP server (ARCHITECTURE §11, D-005): plain Node `http` around the shared fetch-style
// handler (handler.ts), plus `/healthz`. The web app serves the same handler at `/mcp` (D-065).
import { existsSync, realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clientIpFromForwardedFor, log, logError, trustedProxyHops } from "@veradact/core";
import { createDb } from "@veradact/db";
import { createMcpHandler, mcpErrorResponse, mcpMethodNotAllowed, type McpHandlerOptions } from "./handler";

export interface McpHttpServerOptions extends McpHandlerOptions {
  /** Proxies in front of the server that append to X-Forwarded-For. Default: `TRUSTED_PROXY_HOPS` (1). */
  trustedProxyHops?: number;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Client IP: the `x-forwarded-for` entry written by the first of `trustedProxyHops` proxies (the
 * web app's rule), else the socket address. With 0 hops the header is ignored. Used only as a
 * rate-limit key (hashed), never logged.
 */
function clientIp(req: IncomingMessage, trustedProxyHops: number): string {
  return clientIpFromForwardedFor(header(req, "x-forwarded-for"), trustedProxyHops, req.socket.remoteAddress || "unknown");
}

/**
 * The request body as a web stream that touches `req` only once it is read. A body the handler
 * never reads (401, 405, 429) is then left to Node, which drains it so the keep-alive connection
 * stays usable; an eagerly attached stream would stall it.
 */
function lazyBody(req: IncomingMessage): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        reader ??= (Readable.toWeb(req) as ReadableStream<Uint8Array>).getReader();
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel: (reason) => reader?.cancel(reason),
    },
    { highWaterMark: 0 },
  );
}

/** `req` as a fetch Request whose signal aborts when the connection closes. */
function toWebRequest(req: IncomingMessage, res: ServerResponse): Request {
  const closed = new AbortController();
  res.once("close", () => closed.abort());
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, v);
  }
  const body = req.method === "GET" || req.method === "HEAD" ? null : lazyBody(req);
  return new Request(new URL(req.url ?? "/", "http://localhost"), { method: req.method, headers, body, signal: closed.signal, duplex: "half" } as RequestInit);
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

/** An `http.Server` (not listening) serving `/mcp` and `/healthz`. */
export function createMcpHttpServer(options: McpHttpServerOptions): Server {
  const handleMcp = createMcpHandler(options);
  const hops = options.trustedProxyHops ?? trustedProxyHops();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/healthz") {
      if (req.method === "GET" || req.method === "HEAD") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(req.method === "HEAD" ? undefined : JSON.stringify({ ok: true }));
      } else await send(res, mcpErrorResponse(405, "Method not allowed.", { allow: "GET, HEAD" }));
      return;
    }
    if (path !== "/mcp") {
      await send(res, mcpErrorResponse(404, "Not found. The MCP endpoint is /mcp."));
      return;
    }
    // Checked before building a Request, which refuses methods such as TRACE.
    if (req.method !== "POST") {
      await send(res, mcpMethodNotAllowed());
      return;
    }
    await send(res, await handleMcp(toWebRequest(req, res), clientIp(req, hops)));
  }

  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      logError("mcp.request_failed", error);
      if (!res.headersSent) void send(res, mcpErrorResponse(500, "Internal server error."));
      else res.end();
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Entry point (`pnpm --filter @veradact/mcp dev|start`). Importing this module starts nothing.

/** The repo-root .env outside production (like the web app and `pnpm jobs:run`); set variables win. */
function loadRootEnv(): void {
  const path = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (process.env.NODE_ENV !== "production" && existsSync(path)) process.loadEnvFile(path);
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
