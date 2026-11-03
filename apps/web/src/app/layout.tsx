import type { Metadata } from "next";
import { Newsreader } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

// Self-hosted at build time by next/font: browsers never request Google Fonts (D-063).
const newsreader = Newsreader({ subsets: ["latin"], variable: "--font-newsreader", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Veradact", template: "%s · Veradact" },
  description: "Proof of what your client agreed to.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={newsreader.variable}>
      <body className="min-h-screen bg-paper text-zinc-900 antialiased">{children}</body>
    </html>
  );
}
