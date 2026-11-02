import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// Next compiles this file to CommonJS, so __dirname is apps/web.
const webDir = typeof __dirname === "string" ? __dirname : process.cwd();
const repoRoot = path.resolve(webDir, "../..");

// `pnpm dev` reads the repo-root .env (Next only loads .env files from apps/web). This runs
// at module load on purpose: Next records env changes made while loading the config and
// hands them to its dev worker; changes made later are dropped on Next's env reloads.
// `next build`/`next start` run with NODE_ENV=production and use the real environment.
// process.loadEnvFile never overrides variables that are already set.
const rootEnvFile = path.join(repoRoot, ".env");
if (process.env.NODE_ENV !== "production" && existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);

/** Security headers for every response (ARCHITECTURE §14). Client pages add their own CSP. */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  transpilePackages: [
    "@veradact/ai",
    "@veradact/core",
    "@veradact/db",
    "@veradact/email",
    "@veradact/export",
    "@veradact/ingest",
  ],
  serverExternalPackages: ["pdfkit", "mammoth"],
  poweredByHeader: false,
  // The dev request log prints full URLs; never print magic-link or client-link tokens.
  logging: { incomingRequests: { ignore: [/^\/auth\/verify/, /^\/c\//] } },
  outputFileTracingRoot: repoRoot,
  // Prompts are read from disk at runtime by @veradact/ai.
  outputFileTracingIncludes: { "/**": ["../../packages/ai/prompts/**/*"] },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
