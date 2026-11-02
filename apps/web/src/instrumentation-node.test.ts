import { afterEach, describe, expect, it, vi } from "vitest";
import { checkStartupConfiguration } from "./instrumentation-node";

const LINK_SIGNING_SECRET = "Jt5Q9wz1nXk3c7Vb0Rm2Ys8Lp4Hd6Fa+";

/** Production with valid secrets (whatever the developer's .env holds), so only the proxy check decides. */
function stubProductionSecrets(): void {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("LINK_SIGNING_SECRET", LINK_SIGNING_SECRET);
  vi.stubEnv("SESSION_SECRET", "");
  vi.stubEnv("CRON_SECRET", "");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function run(): { exitCode: number | undefined; stderr: string } {
  let exitCode: number | undefined;
  let stderr = "";
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code;
  }) as typeof process.exit);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
    stderr += chunk;
    return true;
  }) as typeof process.stderr.write);
  checkStartupConfiguration();
  return { exitCode, stderr };
}

describe("checkStartupConfiguration", () => {
  it("stops a production web server configured without a trusted proxy", () => {
    stubProductionSecrets();
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    const { exitCode, stderr } = run();
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/^veradact: Refusing to start in production: TRUSTED_PROXY_HOPS=0/);
  });

  it("starts with one or more trusted proxies in production, and with 0 in development", () => {
    stubProductionSecrets();
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    expect(run().exitCode).toBeUndefined();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    expect(run().exitCode).toBeUndefined();
  });
});
