import Link from "next/link";
import type { ReactNode } from "react";
import type { ReplayDiff, ResponseEventRef } from "@veradact/core";
import { Badge } from "@/components";
import { formatDateTime } from "@/lib/format";
import { KIND_LABELS, STATUS_LABELS, STATUS_TONES, SUPERSEDE_REASON_LABELS, WITHDRAW_REASON_LABELS } from "@/lib/labels";
import { WordDiff } from "../word-diff";
import type { ReplayContext } from "./known-view";

function ItemLink({ shortId, ctx }: { shortId: string | null; ctx: ReplayContext }) {
  if (!shortId) return <span className="font-mono text-xs text-zinc-500">unknown item</span>;
  return (
    <Link href={`${ctx.base}/items/${shortId}`} className="font-mono text-xs font-medium text-zinc-900 hover:underline">
      {shortId}
    </Link>
  );
}

function DiffSection({ title, count, testId, children }: { title: string; count: number; testId: string; children: ReactNode }) {
  return (
    <section className="space-y-2" data-testid={testId}>
      <h3 className="text-sm font-semibold text-zinc-900">
        {title} <span className="font-normal text-zinc-500">({count})</span>
      </h3>
      {count === 0 ? <p className="text-sm text-zinc-500">None.</p> : <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white">{children}</ul>}
    </section>
  );
}

function ResponseRows({ refs, ctx }: { refs: ResponseEventRef[]; ctx: ReplayContext }) {
  return (
    <>
      {refs.map((r) => (
        <li key={r.seq} className="flex flex-wrap items-baseline gap-x-2 px-4 py-2 text-sm">
          <ItemLink shortId={r.shortId} ctx={ctx} />
          <span className="text-zinc-600">v{r.version}</span>
          <span>{ctx.contactName(r.contactId, r.contactErased)}</span>
          <span className="text-xs text-zinc-500">{formatDateTime(r.recordedAt, ctx.timeZone)}</span>
        </li>
      ))}
    </>
  );
}

/** `diff(T1, T2)` as sections: Added / Revised (word diff) / Confirmed / Disputed / Superseded / Withdrawn. */
export function CompareSections({ diff, ctx }: { diff: ReplayDiff; ctx: ReplayContext }) {
  return (
    <div className="space-y-5">
      <DiffSection title="Added" count={diff.added.length} testId="diff-added">
        {diff.added.map((a) => (
          <li key={a.itemId} className="space-y-1 px-4 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <ItemLink shortId={a.shortId} ctx={ctx} />
              <span className="text-xs text-zinc-500">{KIND_LABELS[a.kind]}</span>
              <Badge tone={STATUS_TONES[a.status]}>{STATUS_LABELS[a.status]}</Badge>
              <span className="text-xs text-zinc-500">recorded {formatDateTime(a.recordedAt, ctx.timeZone)}</span>
            </div>
            <p className="text-zinc-800">{a.statement}</p>
          </li>
        ))}
      </DiffSection>
      <DiffSection title="Revised" count={diff.revised.length} testId="diff-revised">
        {diff.revised.map((r) => (
          <li key={r.itemId} className="space-y-1 px-4 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <ItemLink shortId={r.shortId} ctx={ctx} />
              <span className="text-xs text-zinc-500">
                v{r.fromVersion} → v{r.toVersion}
              </span>
            </div>
            <WordDiff before={r.fromStatement} after={r.toStatement} />
          </li>
        ))}
      </DiffSection>
      <DiffSection title="Confirmed" count={diff.confirmed.length} testId="diff-confirmed">
        <ResponseRows refs={diff.confirmed} ctx={ctx} />
      </DiffSection>
      <DiffSection title="Disputed" count={diff.disputed.length} testId="diff-disputed">
        <ResponseRows refs={diff.disputed} ctx={ctx} />
      </DiffSection>
      <DiffSection title="Superseded" count={diff.superseded.length} testId="diff-superseded">
        {diff.superseded.map((s) => (
          <li key={s.seq} className="flex flex-wrap items-baseline gap-x-2 px-4 py-2 text-sm">
            <ItemLink shortId={s.shortId} ctx={ctx} />
            <span className="text-zinc-600">by</span>
            <ItemLink shortId={s.supersededByShortId} ctx={ctx} />
            <span className="text-xs text-zinc-500">
              {SUPERSEDE_REASON_LABELS[s.reasonCode]} · {formatDateTime(s.recordedAt, ctx.timeZone)}
            </span>
          </li>
        ))}
      </DiffSection>
      <DiffSection title="Withdrawn" count={diff.withdrawn.length} testId="diff-withdrawn">
        {diff.withdrawn.map((w) => (
          <li key={w.seq} className="flex flex-wrap items-baseline gap-x-2 px-4 py-2 text-sm">
            <ItemLink shortId={w.shortId} ctx={ctx} />
            <span className="text-xs text-zinc-500">
              {WITHDRAW_REASON_LABELS[w.reasonCode]} · {formatDateTime(w.recordedAt, ctx.timeZone)}
            </span>
          </li>
        ))}
      </DiffSection>
    </div>
  );
}
