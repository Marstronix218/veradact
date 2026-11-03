// /mcp — the remote MCP endpoint (ARCHITECTURE §11) served by the web app, so a serverless
// deployment needs no second process (D-065). Same handler as the standalone server (apps/mcp):
// stateless, POST only, bearer API tokens; no cookies, so no CSRF check.
import type { NextRequest } from "next/server";
import { createMcpHandler, type McpHandler } from "@veradact/mcp/handler";
import { getDb } from "@/lib/db";
import { clientIpFrom } from "@/lib/request";

export const dynamic = "force-dynamic";

let handler: McpHandler | undefined;

function handle(request: NextRequest): Promise<Response> {
  handler ??= createMcpHandler({ db: getDb() });
  return handler(request, clientIpFrom(request.headers));
}

// Every other method answers the handler's 405, as the standalone server does.
export { handle as DELETE, handle as GET, handle as OPTIONS, handle as PATCH, handle as POST, handle as PUT };
