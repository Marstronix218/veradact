import type { NextConfig } from "next";

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
};

export default nextConfig;
