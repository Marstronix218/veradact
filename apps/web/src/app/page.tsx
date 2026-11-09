import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { isSignupEnabled, type Kind } from "@veradact/core";
import { Badge, buttonClasses, Wordmark } from "@/components";
import { KindChip } from "@/components/KindChip";
import { getAuth } from "@/lib/session";

export const metadata: Metadata = {
  title: { absolute: "Veradact · Approvals that stick" },
  description:
    "Turn meeting notes and transcripts into items your client confirms one by one. Only confirmed items reach your coding agents.",
};

/** Signed in: the engagements list. Signed out: the landing page, which links to sign in and sign up. */
export default async function HomePage() {
  if (await getAuth()) redirect("/engagements");
  const signup = isSignupEnabled();

  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-200/80 bg-white/90">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <Wordmark />
          <nav aria-label="Account" className="ml-auto flex items-center gap-2 text-sm">
            <Link href="/login" className={`${buttonClasses(signup ? "secondary" : "primary")} whitespace-nowrap`}>
              Sign in
            </Link>
            {/* On phones the hero's button is enough; a wrapper, because buttonClasses sets inline-flex. */}
            {signup ? (
              <span className="hidden sm:block">
                <Link href="/signup" className={`${buttonClasses()} whitespace-nowrap`}>
                  Create an account
                </Link>
              </span>
            ) : null}
          </nav>
        </div>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl gap-12 px-4 py-16 sm:py-24 lg:grid-cols-[1.1fr_1fr] lg:items-center">
          <div>
            <p className="text-sm font-medium text-ink-700">For forward deployed engineers and implementation teams</p>
            <h1 className="mt-3 font-display text-5xl font-semibold tracking-tight text-ink-950 sm:text-6xl">Approvals that stick.</h1>
            <p className="mt-6 max-w-xl text-lg text-zinc-700">
              Veradact turns your meeting notes and transcripts into a short list of what the client needs, each item quoting where it
              came from. Your client confirms the items one by one from a link, and only confirmed items reach your coding agents.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              {signup ? (
                <Link href="/signup" className={`${buttonClasses()} px-5 py-2.5 text-base`}>
                  Create an account
                </Link>
              ) : null}
              <Link href="/login" className={`${buttonClasses(signup ? "secondary" : "primary")} px-5 py-2.5 text-base`}>
                Sign in
              </Link>
            </div>
            <p className="mt-4 text-sm text-zinc-500">Your clients never need an account or a password.</p>
          </div>
          <ClientPreview />
        </section>

        <section aria-labelledby="why" className="border-y border-zinc-200/80 bg-white">
          <div className="mx-auto max-w-6xl px-4 py-16">
            <h2 id="why" className="font-display text-3xl font-semibold text-ink-950">
              Why sign-offs fall apart
            </h2>
            <div className="mt-10 grid gap-8 md:grid-cols-3">
              <Problem title="The client approved something they didn't fully understand.">
                A long document gets a quick yes and a later &ldquo;that&rsquo;s not what we meant.&rdquo; Veradact asks about one item at a
                time, in plain words, next to the client&rsquo;s own quote.
              </Problem>
              <Problem title="Sales promised it. Delivery inherited it.">
                Add pre-sales notes and the statement of work as sources, turn them into items, and have the client confirm what was promised
                at kickoff.
              </Problem>
              <Problem title="Nobody can find what was decided.">
                One record per engagement. See what both sides knew or had agreed on any past date, and export it with a hash chain that shows
                nothing was changed.
              </Problem>
            </div>
          </div>
        </section>

        <section aria-labelledby="how" className="mx-auto max-w-6xl px-4 py-16">
          <h2 id="how" className="font-display text-3xl font-semibold text-ink-950">
            How it works
          </h2>
          <ol className="mt-10 grid gap-8 md:grid-cols-2 lg:grid-cols-4">
            <Step n={1} title="Add what was said">
              Paste or upload notes, transcripts, emails or chat exports. Veradact reads text that already exists. It never joins or records
              meetings.
            </Step>
            <Step n={2} title="Turn it into items">
              Problems, constraints, assumptions, decisions and requirements. AI can suggest items with exact quotes, and nothing enters the
              record until you accept or edit it.
            </Step>
            <Step n={3} title="Your client confirms">
              They open a link on any device. For each item they confirm it, dispute it and say what is right, or skip it. A changed item goes
              back to them.
            </Step>
            <Step n={4} title="Build from what's confirmed">
              Export a spec of confirmed items as markdown, or connect Claude Code, Cursor or Kiro over MCP. Everything else is listed as
              &ldquo;do not build.&rdquo;
            </Step>
          </ol>
        </section>

        <section aria-labelledby="trust" className="border-t border-zinc-200/80 bg-white">
          <div className="mx-auto max-w-6xl px-4 py-16">
            <h2 id="trust" className="font-display text-3xl font-semibold text-ink-950">
              Built for client data
            </h2>
            <dl className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
              <Fact term="A record you can show">
                Every change is an append-only, hash-chained event. Export the record as PDF or markdown with its chain check.
              </Fact>
              <Fact term="AI off means off">
                Turn AI off for your organization or one engagement, and no source text goes to a model provider.
              </Fact>
              <Fact term="Never used for training">Your data and your clients&rsquo; data are never used to train or fine-tune models.</Fact>
              <Fact term="Nothing tracks your clients">Client pages load no third-party scripts, fonts, analytics or trackers.</Fact>
            </dl>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-16 text-center">
          <h2 className="font-display text-3xl font-semibold text-ink-950">Start with one engagement.</h2>
          <p className="mx-auto mt-3 max-w-lg text-zinc-600">
            Bring the notes from your last client call and send the first items for confirmation today.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            {signup ? (
              <Link href="/signup" className={`${buttonClasses()} px-5 py-2.5 text-base`}>
                Create an account
              </Link>
            ) : null}
            <Link href="/login" className={`${buttonClasses(signup ? "secondary" : "primary")} px-5 py-2.5 text-base`}>
              Sign in
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-zinc-200/80">
        <div className="mx-auto max-w-6xl px-4 py-6 text-sm text-zinc-500">Veradact · Proof of what your client agreed to.</div>
      </footer>
    </div>
  );
}

function Problem({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="font-semibold text-zinc-900">{title}</h3>
      <p className="mt-2 text-zinc-600">{children}</p>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li>
      <span
        aria-hidden="true"
        className="inline-flex size-8 items-center justify-center rounded-full bg-ink-900 font-mono text-sm font-semibold text-white"
      >
        {n}
      </span>
      <h3 className="mt-4 font-semibold text-zinc-900">{title}</h3>
      <p className="mt-2 text-zinc-600">{children}</p>
    </li>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt className="font-semibold text-zinc-900">{term}</dt>
      <dd className="mt-2 text-zinc-600">{children}</dd>
    </div>
  );
}

interface PreviewItem {
  kind: Kind;
  shortId: string;
  statement: string;
  quote: string;
  source: string;
  response: { status: "confirmed"; note: string } | { status: "disputed"; comment: string };
}

// Illustration only, with the fictional demo client from the seed (Halvorsen Freight).
const PREVIEW: readonly PreviewItem[] = [
  {
    kind: "requirement",
    shortId: "HALV-R4",
    statement: "Dispatchers can override any suggested route before it is sent to the driver.",
    quote: "If the system picks a route, my team still needs the final say.",
    source: "Kickoff call · 8 Sep",
    response: { status: "confirmed", note: "Confirmed by Halvorsen Freight · 10 Sep" },
  },
  {
    kind: "assumption",
    shortId: "HALV-A2",
    statement: "Most re-routing happens because pickups run late.",
    quote: "Late pickups are what blow up the afternoon.",
    source: "Kickoff call · 8 Sep",
    response: { status: "disputed", comment: "Mostly it is weather and road closures. Late pickups are maybe one in five." },
  },
];

/** A static picture of the client page with one confirmed and one disputed item. */
function ClientPreview() {
  return (
    <figure className="rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-sm sm:p-6">
      <figcaption className="flex items-center justify-between gap-3 border-b border-zinc-100 pb-3 text-sm">
        <span className="font-medium text-zinc-900">AI dispatch routing</span>
        <span className="text-zinc-500">What your client sees</span>
      </figcaption>
      <ul className="mt-4 space-y-4">
        {PREVIEW.map((item) => (
          <li key={item.shortId} className="rounded-xl border border-zinc-200/80 p-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <KindChip kind={item.kind} />
              <span className="font-mono text-xs text-zinc-500">{item.shortId}</span>
              <span className="ml-auto">
                {item.response.status === "confirmed" ? (
                  <Badge tone="green" dot>
                    Confirmed
                  </Badge>
                ) : (
                  <Badge tone="red" dot>
                    Disputed
                  </Badge>
                )}
              </span>
            </div>
            <p className="mt-3 font-display text-lg leading-snug text-zinc-900">{item.statement}</p>
            <blockquote className="mt-3 border-l-2 border-ink-200 pl-3 text-sm text-zinc-600">
              &ldquo;{item.quote}&rdquo;
              <span className="mt-1 block text-xs text-zinc-500">{item.source}</span>
            </blockquote>
            {item.response.status === "confirmed" ? (
              <p className="mt-3 text-xs text-green-800">{item.response.note}</p>
            ) : (
              <p className="mt-3 rounded-lg bg-red-50/70 px-3 py-2 text-sm text-red-900">
                <span className="block text-xs font-medium">What is right instead?</span>
                {item.response.comment}
              </p>
            )}
          </li>
        ))}
      </ul>
    </figure>
  );
}
