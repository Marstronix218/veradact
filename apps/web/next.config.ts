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

/**
 * Security headers for every response (ARCHITECTURE §14). Client pages add their own CSP. Next
 * evaluates `headers()` at build time, so HSTS is part of every production build; browsers ignore
 * it on plain-http responses, and dev servers never send it (it would pin localhost to https).
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  ...(process.env.NODE_ENV === "production" ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
];

const nextConfig: NextConfig = {
  transpilePackages: [
    "@veradact/ai",
    "@veradact/core",
    "@veradact/db",
    "@veradact/email",
    "@veradact/export",
    "@veradact/ingest",
    "@veradact/mcp",
  ],
  serverExternalPackages: ["pdfkit", "mammoth"],
  poweredByHeader: false,
  // The dev request log prints full URLs; never print magic-link or client-link tokens.
  logging: { incomingRequests: { ignore: [/^\/auth\/verify/, /^\/signup\/complete/, /^\/c\//] } },
  outputFileTracingRoot: repoRoot,
  // Prompts are read from disk at runtime by @veradact/ai; the fixture model client
  // (MODEL_CLIENT=fixture) reads fixtures/.
  outputFileTracingIncludes: { "/**": ["../../packages/ai/prompts/**/*", "../../fixtures/**/*"] },
  // Source uploads go through a server action; @veradact/ingest caps sources at 5 MB.
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // The magic-link interstitial carries a token in its URL (D-045); later rules win.
      { source: "/auth/verify", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
      // So does the sign-up link (D-062). strict-origin, not no-referrer: its form posts to a server
      // action, and no-referrer would send `Origin: null`, which Next's action handler cannot parse.
      { source: "/signup/complete", headers: [{ key: "Referrer-Policy", value: "strict-origin" }] },
      // Client confirmation pages carry the link token in their URL (ARCHITECTURE §8.3). Config
      // headers override route-handler headers, so the stricter value must be set here too.
      { source: "/c/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    ];
  },
};

export default nextConfig;
