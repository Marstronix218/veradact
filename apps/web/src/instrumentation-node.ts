// Startup checks for the Node.js server (see instrumentation.ts). Configuration that would be unsafe
// stops the process instead of failing on the first request (ARCHITECTURE §14): in production the
// `.env.example` placeholder secrets, and anywhere an invalid TRUSTED_PROXY_HOPS. Next would keep
// listening and answer 500 if register() threw, so the process exits for the platform to report.
import { assertProductionSecrets, trustedProxyHops } from "@veradact/core";

export function checkStartupConfiguration(): void {
  try {
    assertProductionSecrets();
    trustedProxyHops();
  } catch (error) {
    // The messages name variables only, never their values.
    process.stderr.write(`veradact: ${error instanceof Error ? error.message : "invalid configuration"}\n`);
    process.exit(1);
  }
}
