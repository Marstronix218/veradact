// Server-side environment access. Read lazily (never at import time) so `next build` works
// without a database or secrets.

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

/** Public base URL of the web app (links in emails, redirects), without a trailing slash. */
export function appUrl(): string {
  return requireEnv("APP_URL").replace(/\/+$/, "");
}

/**
 * Public URL of the MCP endpoint shown on the API tokens page: `MCP_PUBLIC_URL` when agents use
 * the standalone server (apps/mcp), else this app's own `/mcp` route (D-065).
 */
export function mcpPublicUrl(): string {
  return process.env.MCP_PUBLIC_URL?.trim() || `${appUrl()}/mcp`;
}
