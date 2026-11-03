import type { Metadata } from "next";
import Link from "next/link";
import { asOf, decisionContext, diff, ERASED_CONTACT_NAME, listContacts, readEvents, type StoredEvent, type ViewHead } from "@veradact/core";
import { currentCut } from "@veradact/export/server";
import { Button, Input, Notice, Select } from "@/components";
import { clock } from "@/lib/clock";
import { isAfterLocalToday } from "@/lib/dates";
import { requireEngagement } from "@/lib/engagement";
import { formatDate, formatDateTime } from "@/lib/format";
import { KIND_LABELS, STATUS_LABELS } from "@/lib/labels";
import { withAuthTenant } from "@/lib/session";
import { AgreedSection } from "./agreed-view";
import { CompareSections } from "./compare-view";
import { DecisionContextSection } from "./decision-context";
import { KnownItemsTable, type ReplayContext } from "./known-view";
import { parseReplayParams, replayHref, type ReplaySearch, type ReplayTab, type ResolvedInstant } from "./params";

export const metadata: Metadata = { title: "Replay" };

const TABS: { tab: ReplayTab; label: string }[] = [
  { tab: "known", label: "Known" },
  { tab: "agreed", label: "Agreed" },
  { tab: "compare", label: "Compare" },
];

/** The item id for a short id (any case) or item id, from the log. */
function findItemId(events: readonly StoredEvent[], ref: string): string | null {
  const upper = ref.toUpperCase();
  const lower = ref.toLowerCase();
  for (const ev of events) {
    if (ev.type === "item_created" && (ev.payload.short_id === upper || ev.payload.item_id === lower)) return ev.payload.item_id;
  }
  return null;
}

function versionsOf(events: readonly StoredEvent[], itemId: string): number[] {
  const versions: number[] = [];
  for (const ev of events) {
    if ((ev.type === "item_created" || ev.type === "item_revised") && ev.payload.item_id === itemId) versions.push(ev.payload.version);
  }
  return versions;
}

function InstantText({ instant, timeZone, now }: { instant: ResolvedInstant; timeZone: string; now: Date }) {
  if (!instant.endOfDay && (instant.input === "" || instant.error)) return <>now, {formatDateTime(now, timeZone)}</>;
  return (
    <>
      {instant.endOfDay ? `the end of ${formatDate(instant.at, timeZone)}` : formatDateTime(instant.at, timeZone)}{" "}
      <span className="font-mono text-xs text-zinc-500">({instant.at.toISOString()})</span>
    </>
  );
}

function HeadText({ head, label }: { head: ViewHead; label: string }) {
  return (
    <p className="break-all text-xs text-zinc-500" data-testid="replay-head">
      {head.seq === 0 ? (
        `${label}: no events recorded yet.`
      ) : (
        <>
          {label}: seq {head.seq} · <span className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-zinc-700">{head.hash}</span>
        </>
      )}
    </p>
  );
}

export default async function ReplayPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<ReplaySearch> }) {
  const { id } = await params;
  const e = await requireEngagement(id);
  const { events, contacts } = await withAuthTenant(async (tx) => {
    const [events, contacts] = await Promise.all([readEvents(tx, e.id), listContacts(tx, e.id)]);
    return { events, contacts };
  });
  // "Now" covers the whole log: recorded_at can run ahead of this server's clock (`currentCut`).
  const now = currentCut(clock(), events);
  const p = parseReplayParams(await searchParams, e.timeZone, now);
  const base = `/engagements/${e.id}`;
  const names = new Map(contacts.map((c) => [c.id, c.name]));
  const ctx: ReplayContext = {
    base,
    timeZone: e.timeZone,
    contactName: (contactId, erased) => (erased ? ERASED_CONTACT_NAME : (names.get(contactId) ?? ERASED_CONTACT_NAME)),
  };

  // Decision context replaces the tabs: it has its own cut (a seq, not a date).
  if (p.decision) {
    const itemId = findItemId(events, p.decision.ref);
    const context = itemId ? decisionContext(events, itemId, p.decision.version) : null;
    return (
      <div className="space-y-4">
        <Link href={replayHref(base, {})} className="text-sm text-zinc-600 hover:underline">
          ← Back to replay
        </Link>
        {context && itemId ? (
          <DecisionContextSection context={context} versions={versionsOf(events, itemId)} ctx={ctx} />
        ) : (
          <Notice tone="error">That item or version does not exist in this engagement.</Notice>
        )}
      </div>
    );
  }

  const asOfInput = p.asOf.error ? "" : p.asOf.input;
  const tabHref = (tab: ReplayTab) =>
    tab === "compare" ? replayHref(base, { view: "compare", from: p.from.input, to: p.to.input }) : replayHref(base, { view: tab === "known" ? undefined : tab, as_of: asOfInput });

  return (
    <div className="space-y-5">
      <p className="max-w-3xl text-sm text-zinc-600">
        Replay folds the engagement&apos;s hash-chained log up to a moment: what was known, what was agreed, and what changed between two dates. A date means the end
        of that day in <span className="font-mono">{e.timeZone}</span>; only what had been recorded by then counts.
      </p>

      <nav aria-label="Replay view" className="inline-flex rounded-md border border-zinc-300 bg-white p-0.5 text-sm">
        {TABS.map(({ tab, label }) => (
          <Link
            key={tab}
            href={tabHref(tab)}
            aria-current={p.tab === tab ? "page" : undefined}
            className={`rounded px-3 py-1.5 font-medium ${p.tab === tab ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-zinc-100"}`}
          >
            {label}
          </Link>
        ))}
      </nav>

      {p.tab === "compare" ? (
        <CompareTab p={p} events={events} ctx={ctx} now={now} />
      ) : (
        <div className="space-y-4">
          <form method="get" className="flex flex-wrap items-end gap-3" aria-label="Replay date">
            {p.tab === "agreed" ? <input type="hidden" name="view" value="agreed" /> : null}
            {p.kind ? <input type="hidden" name="kind" value={p.kind} /> : null}
            {p.status ? <input type="hidden" name="status" value={p.status} /> : null}
            <div className="w-44">
              <Input type="date" name="as_of" label="As of" defaultValue={p.asOf.date} required />
            </div>
            <Button type="submit" variant="secondary">
              Show
            </Button>
            {asOfInput ? (
              <Link href={replayHref(base, { view: p.tab === "agreed" ? "agreed" : undefined })} className="pb-2 text-sm text-zinc-600 hover:underline">
                Now
              </Link>
            ) : null}
          </form>
          {p.asOf.error ? <Notice tone="error">That as-of date is not valid; showing the ledger as it is now.</Notice> : null}
          {isAfterLocalToday(p.asOf.at, now, e.timeZone) ? <Notice>That date is in the future; the view shows everything recorded so far.</Notice> : null}
          <div className="space-y-1">
            <p className="text-sm text-zinc-800" data-testid="replay-as-of">
              Showing the ledger as of <InstantText instant={p.asOf} timeZone={e.timeZone} now={now} /> · time zone <span className="font-mono">{e.timeZone}</span>
            </p>
          </div>
          {p.tab === "known" ? <KnownTab p={p} events={events} ctx={ctx} asOfInput={asOfInput} /> : <AgreedTab p={p} events={events} ctx={ctx} asOfInput={asOfInput} />}
        </div>
      )}
    </div>
  );
}

type TabProps = { p: ReturnType<typeof parseReplayParams>; events: StoredEvent[]; ctx: ReplayContext };

function KnownTab({ p, events, ctx, asOfInput }: TabProps & { asOfInput: string }) {
  const known = asOf(events, p.asOf.at, "known");
  const items = known.items.filter((i) => (!p.kind || i.kind === p.kind) && (!p.status || i.status === p.status));
  const filtered = Boolean(p.kind || p.status);
  return (
    <div className="space-y-4">
      <HeadText head={known.head} label="Log head at this time" />
      <form method="get" className="flex flex-wrap items-end gap-3" aria-label="Filter items">
        {asOfInput ? <input type="hidden" name="as_of" value={asOfInput} /> : null}
        <div className="w-40">
          <Select name="kind" label="Kind" defaultValue={p.kind ?? ""}>
            <option value="">All kinds</option>
            {Object.entries(KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-40">
          <Select name="status" label="Status at that time" defaultValue={p.status ?? ""}>
            <option value="">All statuses</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="secondary">
          Filter
        </Button>
        {filtered ? (
          <Link href={replayHref(ctx.base, { as_of: asOfInput })} className="pb-2 text-sm text-zinc-600 hover:underline">
            Clear
          </Link>
        ) : null}
      </form>
      <p className="text-sm text-zinc-600">
        {known.items.length === 1 ? "1 item" : `${known.items.length} items`} known at this time, including superseded and withdrawn ones
        {filtered ? ` · ${items.length} shown` : ""}.
      </p>
      <KnownItemsTable items={items} ctx={ctx} emptyText={filtered ? "No items match these filters at this time" : "Nothing had been recorded by this time"} />
    </div>
  );
}

function AgreedTab({ p, events, ctx, asOfInput }: TabProps & { asOfInput: string }) {
  const agreed = asOf(events, p.asOf.at, "agreed");
  return (
    <div className="space-y-4">
      <HeadText head={agreed.head} label="Log head at this time" />
      <AgreedSection view={agreed} ctx={ctx} />
      {agreed.notConfirmed.length > 0 ? (
        <p className="text-sm text-zinc-600">
          {agreed.notConfirmed.length === 1 ? "1 active item was" : `${agreed.notConfirmed.length} active items were`} not confirmed at this time and{" "}
          {agreed.notConfirmed.length === 1 ? "is" : "are"} not shown here.{" "}
          <Link href={replayHref(ctx.base, { as_of: asOfInput })} className="text-blue-700 hover:underline">
            See the known view
          </Link>
          .
        </p>
      ) : null}
    </div>
  );
}

function CompareTab({ p, events, ctx, now }: TabProps & { now: Date }) {
  const invalid = p.from.error || p.to.error;
  const reversed = !invalid && p.from.at.getTime() > p.to.at.getTime();
  const result = invalid || reversed ? null : diff(events, p.from.at, p.to.at);
  return (
    <div className="space-y-4">
      <form method="get" className="flex flex-wrap items-end gap-3" aria-label="Compare two dates">
        <input type="hidden" name="view" value="compare" />
        <div className="w-44">
          <Input type="date" name="from" label="From" defaultValue={p.from.date} required />
        </div>
        <div className="w-44">
          <Input type="date" name="to" label="To" defaultValue={p.to.date} required />
        </div>
        <Button type="submit" variant="secondary">
          Compare
        </Button>
      </form>
      {invalid ? <Notice tone="error">Enter two valid dates.</Notice> : null}
      {reversed ? <Notice tone="error">The first date must not be after the second.</Notice> : null}
      {result ? (
        <>
          <div className="space-y-1">
            <p className="text-sm text-zinc-800" data-testid="replay-as-of">
              Changes recorded after <InstantText instant={p.from} timeZone={ctx.timeZone} now={now} /> up to{" "}
              <InstantText instant={p.to} timeZone={ctx.timeZone} now={now} /> · time zone <span className="font-mono">{ctx.timeZone}</span>
            </p>
            <HeadText head={result.fromHead} label="Log head at the first date" />
            <HeadText head={result.toHead} label="Log head at the second date" />
          </div>
          <CompareSections diff={result} ctx={ctx} />
        </>
      ) : null}
    </div>
  );
}
