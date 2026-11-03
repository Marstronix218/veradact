// Startup checks for the Node.js server (see instrumentation.ts). Configuration that would be unsafe
// stops the process instead of failing on the first request (ARCHITECTURE §14): in production the
// `.env.example` placeholder secrets and TRUSTED_PROXY_HOPS=0 (no proxy: every request would share
// one rate-limit key), and anywhere an invalid TRUSTED_PROXY_HOPS. Next would keep listening and
// answer 500 if register() threw, so the process exits for the platform to report.
import { assertProductionSecrets, log, webTrustedProxyHops } from "@veradact/core";

export function checkStartupConfiguration(): void {
  try {
    assertProductionSecrets();
    webTrustedProxyHops();
    // Demo password sign-in never runs in production (D-064); say so instead of ignoring it silently.
    if (process.env.NODE_ENV === "production" && process.env.DEMO_LOGIN_PASSWORD?.trim()) log.warn("auth.demo_login.ignored_in_production");
  } catch (error) {
    // The messages name variables, never secret values.
    process.stderr.write(`veradact: ${error instanceof Error ? error.message : "invalid configuration"}\n`);
    process.exit(1);
  }
}
