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

/** Public URL of the MCP endpoint shown on the API tokens page, or null when unset. */
export function mcpPublicUrl(): string | null {
  return process.env.MCP_PUBLIC_URL?.trim() || null;
}
