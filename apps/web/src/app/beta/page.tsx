import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark } from "@/components";

export const metadata: Metadata = { title: "Beta & responsible use" };

export default function BetaNoticePage() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-200/80 bg-white/90">
        <div className="mx-auto max-w-3xl px-4 py-3">
          <Link href="/" className="inline-block rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink-600">
            <Wordmark />
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-12 sm:py-16">
        <p className="text-sm font-medium text-violet-700">Early-stage product notice</p>
        <h1 className="mt-2 font-display text-4xl font-semibold tracking-tight text-ink-950">Beta &amp; responsible use</h1>
        <p className="mt-4 text-zinc-600">Last updated November 17, 2026</p>

        <div className="mt-10 space-y-8 text-zinc-700">
          <NoticeSection title="Veradact is still being validated">
            Veradact is an early-stage beta. Features may change, contain errors, or be unavailable. Do not rely on the service as your only
            record of an agreement, approval, requirement, or decision.
          </NoticeSection>

          <NoticeSection title="Review before you rely">
            AI-generated suggestions and summaries can be incomplete or wrong. You are responsible for reviewing source material, confirming
            outputs with the relevant people, keeping appropriate backups, and deciding whether information is suitable for your use.
          </NoticeSection>

          <NoticeSection title="Not professional advice or a legal agreement">
            Veradact helps teams organize and confirm information. It does not provide legal, compliance, security, financial, or other
            professional advice. A confirmation in Veradact is not a substitute for a contract, legal review, or any approval process your
            organization is required to follow.
          </NoticeSection>

          <NoticeSection title="Use remains your responsibility">
            You are responsible for what you upload, who you share it with, and the decisions or actions you take based on the service. Use
            appropriate professional review when the consequences are important.
          </NoticeSection>

          <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            This notice explains the product&rsquo;s current limits; it is not a complete set of legal terms or a privacy policy.
          </p>
        </div>

        <Link href="/" className="mt-10 inline-block text-sm font-medium text-ink-700 underline underline-offset-4 hover:text-ink-950">
          Back to the landing page
        </Link>
      </main>
    </div>
  );
}

function NoticeSection({ title, children }: { title: string; children: string }) {
  return (
    <section>
      <h2 className="font-display text-2xl font-semibold text-ink-950">{title}</h2>
      <p className="mt-2 leading-7">{children}</p>
    </section>
  );
}
