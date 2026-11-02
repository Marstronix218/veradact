// Where a connection string really points, for the dev-only guards (bootstrap, seed --reset).
// postgres.js lets `?host=` override the host in the URL (and PGHOST fill in a missing one), so
// the guards read its parsed options instead of `new URL(url).hostname`.
import postgres from "postgres";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** Hosts postgres.js would connect to (lowercase; a Unix socket directory starts with `/`), or null for a non-postgres URL. */
export function connectionHosts(url: string): string[] | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return null;
  // Parsing opens no connection; end() just releases the unused client.
  const client = postgres(url, { max: 1 });
  void client.end({ timeout: 0 });
  return client.options.host.map((host) => host.toLowerCase());
}

/** True when every host the URL connects to is this machine: a loopback name or address, or a Unix socket. */
export function isLocalDatabaseUrl(url: string): boolean {
  const hosts = connectionHosts(url);
  return hosts !== null && hosts.length > 0 && hosts.every((host) => LOCAL_HOSTS.has(host) || host.startsWith("/"));
}
