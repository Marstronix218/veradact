import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getItemDetail, listItems, listSources, type ItemRef, type SpanDetail, type VersionDetail } from "@veradact/core";
import { ActionForm, Badge, Button, buttonClasses, Card, Checkbox, Notice, Select, Table, TBody, Td, Textarea, Tr } from "@/components";
import { requireEngagement, type EngagementView } from "@/lib/engagement";
import { formatDate, formatDateTime } from "@/lib/format";
import {
  KIND_LABELS,
  LIFECYCLE_LABELS,
  REVISE_REASON_LABELS,
  SOURCE_TYPE_LABELS,
  STATUS_LABELS,
  STATUS_TONES,
  SUPERSEDE_REASON_LABELS,
  WITHDRAW_REASON_LABELS,
} from "@/lib/labels";
import { withAuthTenant } from "@/lib/session";
import { WordDiff } from "../../word-diff";
import {
  addDependencyAction,
  clearReviewAction,
  removeDependencyAction,
  reviseItemAction,
  supersedeItemAction,
  withdrawItemAction,
} from "../actions";

export const metadata: Metadata = { title: "Item" };

type Segments = Map<string, { speaker: string | null; start: number; end: number }[]>;

const DONE: Record<string, string> = {
  withdrawn: "Item withdrawn. It stays in the history but leaves the agreed record.",
  superseded: "Item superseded.",
  dependency_added: "Dependency added.",
  dependency_removed: "Dependency removed.",
  review_cleared: "Review cleared.",
};

const REVIEW_CAUSE: Record<string, string> = { revised: "was revised", superseded: "was superseded", withdrawn: "was withdrawn", disputed: "was disputed" };

function speakerOf(segments: Segments, span: SpanDetail): string | null {
  return segments.get(span.sourceId)?.find((s) => s.start <= span.start && span.start < s.end)?.speaker ?? null;
}

function SpanView({ span, segments, e }: { span: SpanDetail; segments: Segments; e: EngagementView }) {
  const sourceLabel = span.sourceTitle ?? (span.sourceType ? SOURCE_TYPE_LABELS[span.sourceType] : "Source");
  const speaker = speakerOf(segments, span);
  return (
    <li className="space-y-1" data-testid="span">
      {span.quoteState === "verified" ? (
        <blockquote className="border-l-2 border-amber-300 pl-3 text-sm text-zinc-800" data-testid="verified-quote">
          “{span.quote}”{speaker ? <span className="ml-1 text-zinc-500">— {speaker}</span> : null}
        </blockquote>
      ) : span.quoteState === "redacted" ? (
        <p className="text-sm italic text-zinc-500">Source redacted on {span.sourceRedactedAt ? formatDate(span.sourceRedactedAt, e.timeZone) : "an earlier date"}; the quote can no longer be shown.</p>
      ) : (
        <p className="text-sm italic text-red-700">Quote unavailable: the source text is missing or no longer matches its recorded hash.</p>
      )}
      <p className="text-xs text-zinc-500">
        {span.quoteState === "redacted" ? (
          sourceLabel
        ) : (
          <Link href={`/engagements/${e.id}/sources/${span.sourceId}`} className="hover:underline">
            {sourceLabel}
          </Link>
        )}
        {span.sourceOccurredAt ? ` · ${formatDate(span.sourceOccurredAt, e.timeZone)}` : ""}
        {span.quoteState === "verified" ? " · verified quote" : ""}
        {span.carried ? " · carried from the previous version" : ""}
      </p>
    </li>
  );
}

function VersionCard({ v, previous, current, segments, e }: { v: VersionDetail; previous: VersionDetail | undefined; current: boolean; segments: Segments; e: EngagementView }) {
  return (
    <li className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4" data-testid="version">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-zinc-900">Version {v.version}</span>
        {current ? <Badge tone="blue">Current</Badge> : null}
        <Badge tone={STATUS_TONES[v.status]}>{STATUS_LABELS[v.status]}</Badge>
        {v.reasonCode ? <span className="text-xs text-zinc-500">Revised: {REVISE_REASON_LABELS[v.reasonCode]}</span> : null}
        <span className="text-xs text-zinc-500">Recorded {formatDateTime(v.recordedAt, e.timeZone)}</span>
      </div>
      {previous ? <WordDiff before={previous.statement} after={v.statement} /> : <p className="text-sm text-zinc-800">{v.statement}</p>}
      {v.note ? <p className="text-xs text-zinc-600">Note: {v.note}</p> : null}
      <p className="text-xs text-zinc-500">
        {v.provenance.via === "ai_candidate"
          ? `Suggested by AI (${v.candidate?.model ?? "model"}, ${v.candidate?.promptVersion ?? "prompt"})${v.candidate?.edited ? ", edited before accepting" : ", accepted as proposed"}${v.candidate?.verification === "offset_corrected" ? ", quote offsets corrected" : ""}`
          : "Entered by a team member"}
        <span className="ml-2 font-mono" title={v.contentHash}>
          #{v.contentHash.slice(0, 12)}
        </span>
      </p>
      {v.manual ? (
        <p className="text-sm text-zinc-700" data-testid="manual-entry">
          Entered manually by {v.manual.enteredByName ?? "a former user"}
        </p>
      ) : (
        <ul className="space-y-3">
          {v.spans.map((s) => (
            <SpanView key={`${s.sourceId}:${s.start}:${s.end}`} span={s} segments={segments} e={e} />
          ))}
        </ul>
      )}
      {v.responses.length > 0 ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Client responses</p>
          <ul className="mt-1 space-y-1 text-sm">
            {v.responses.map((r) => (
              <li key={r.eventSeq}>
                <span className="font-medium">{r.contactName}</span>{" "}
                <Badge tone={r.response === "confirmed" ? "green" : "red"}>{r.response === "confirmed" ? "Confirmed" : "Disputed"}</Badge>{" "}
                <span className="text-zinc-500">
                  v{r.version} · {formatDateTime(r.recordedAt, e.timeZone)}
                </span>
                {r.response === "disputed" && r.comment ? <p className="mt-0.5 text-zinc-700">“{r.comment}”</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  );
}

function RefTable({ title, refs, e, removeFor }: { title: string; refs: (ItemRef & { addedSeq: number })[]; e: EngagementView; removeFor?: string }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
      {refs.length === 0 ? (
        <p className="text-sm text-zinc-500">None.</p>
      ) : (
        <Table>
          <TBody>
            {refs.map((r) => (
              <Tr key={r.id}>
                <Td className="whitespace-nowrap">
                  <Link href={`/engagements/${e.id}/items/${r.shortId}`} className="font-mono text-xs hover:underline">
                    {r.shortId}
                  </Link>
                </Td>
                <Td className="text-zinc-700">{r.statement}</Td>
                <Td>
                  <Badge tone={STATUS_TONES[r.status]}>{STATUS_LABELS[r.status]}</Badge>
                  {r.lifecycle !== "active" ? <span className="ml-1 text-xs text-zinc-500">{LIFECYCLE_LABELS[r.lifecycle]}</span> : null}
                </Td>
                {removeFor ? (
                  <Td className="text-right">
                    <ActionForm action={removeDependencyAction}>
                      <input type="hidden" name="engagementId" value={e.id} />
                      <input type="hidden" name="itemId" value={removeFor} />
                      <input type="hidden" name="dependsOnItemId" value={r.id} />
                      <Button type="submit" size="sm" variant="secondary">
                        Remove
                      </Button>
                    </ActionForm>
                  </Td>
                ) : null}
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}

export default async function ItemPage({ params, searchParams }: { params: Promise<{ id: string; itemId: string }>; searchParams: Promise<{ created?: string; done?: string }> }) {
  const { id, itemId } = await params;
  const { created, done } = await searchParams;
  const e = await requireEngagement(id);
  const data = await withAuthTenant(async (tx) => {
    const detail = await getItemDetail(tx, e.id, itemId);
    if (!detail) return null;
    const sourceIds = [...new Set(detail.versions.flatMap((v) => v.spans.map((s) => s.sourceId)))];
    const segRows = sourceIds.length
      ? await tx.query.sourceContent.findMany({ columns: { sourceId: true, segments: true }, where: (s, { inArray }) => inArray(s.sourceId, sourceIds) })
      : [];
    const [sources, active] = await Promise.all([listSources(tx, e.id), listItems(tx, e.id, { lifecycle: "active" })]);
    return {
      detail,
      segments: new Map(segRows.map((r) => [r.sourceId, r.segments as { speaker: string | null; start: number; end: number }[]])) as Segments,
      sources: sources.filter((s) => !s.redactedAt),
      active,
    };
  });
  if (!data) notFound();
  const { detail: item, segments, sources, active } = data;
  const current = item.versions.find((v) => v.version === item.currentVersion)!;
  const others = active.filter((i) => i.id !== item.id);
  const canHaveDependencies = item.kind === "decision" || item.kind === "requirement";
  const dependencyChoices = others.filter((i) => !item.dependencies.some((d) => d.id === i.id));
  const isActive = item.lifecycle === "active";
  const hidden = (
    <>
      <input type="hidden" name="engagementId" value={e.id} />
      <input type="hidden" name="itemId" value={item.id} />
    </>
  );

  return (
    <div className="space-y-6">
      {created ? <Notice tone="success">Item added to the ledger. It is pending until the client confirms it.</Notice> : null}
      {done && DONE[done] ? <Notice tone="success">{DONE[done]}</Notice> : null}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-semibold text-zinc-900" data-testid="item-short-id">
            {item.shortId}
          </span>
          <Badge>{KIND_LABELS[item.kind]}</Badge>
          <Badge tone={STATUS_TONES[item.status]}>{STATUS_LABELS[item.status]}</Badge>
          {isActive ? null : <Badge tone="neutral">{LIFECYCLE_LABELS[item.lifecycle]}</Badge>}
          {item.needsReview ? <Badge tone="yellow">Needs review</Badge> : null}
          <span className="text-xs text-zinc-500">v{item.currentVersion}</span>
        </div>
        <p className="text-lg text-zinc-900" data-testid="item-statement">
          {current.statement}
        </p>
        {item.supersededBy ? (
          <p className="text-sm text-zinc-600">
            Superseded by{" "}
            <Link href={`/engagements/${e.id}/items/${item.supersededBy.shortId}`} className="font-mono hover:underline">
              {item.supersededBy.shortId}
            </Link>
          </p>
        ) : null}
        {item.needsReview ? (
          <Notice>
            Needs review:{" "}
            {item.reviewReasons.map((r, i) => (
              <span key={`${r.upstreamItemId}:${r.seq}`}>
                {i > 0 ? "; " : ""}
                {r.upstreamShortId ? (
                  <Link href={`/engagements/${e.id}/items/${r.upstreamShortId}`} className="font-mono hover:underline">
                    {r.upstreamShortId}
                  </Link>
                ) : (
                  "an upstream item"
                )}{" "}
                {REVIEW_CAUSE[r.cause] ?? r.cause}
              </span>
            ))}
            .
          </Notice>
        ) : null}
      </div>

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-zinc-900">Version history</h2>
        <ul className="space-y-3">
          {[...item.versions].reverse().map((v) => (
            <VersionCard key={v.version} v={v} previous={item.versions.find((p) => p.version === v.version - 1)} current={v.version === item.currentVersion} segments={segments} e={e} />
          ))}
        </ul>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <RefTable title="Depends on" refs={item.dependencies} e={e} removeFor={isActive ? item.id : undefined} />
        <RefTable title="Dependents" refs={item.dependents} e={e} />
      </section>

      {isActive ? (
        <section className="space-y-4">
          <h2 className="text-base font-semibold text-zinc-900">Actions</h2>
          {item.needsReview ? (
            <Card title="Clear review" description="Mark this item as reviewed without changing it.">
              <ActionForm action={clearReviewAction}>
                {hidden}
                <Button type="submit" variant="secondary">
                  Clear review
                </Button>
              </ActionForm>
            </Card>
          ) : null}

          <Card title="Revise" description="Creates a new version. It is pending until the client confirms it; earlier confirmations stay in the history only.">
            <ActionForm action={reviseItemAction} preserveValues className="space-y-4">
              {hidden}
              <input type="hidden" name="expectedVersion" value={item.currentVersion} />
              <Textarea
                name="statement"
                label="Statement"
                rows={3}
                required
                maxLength={2000}
                defaultValue={current.statement}
                hint="Don't include personal data: statements become part of the permanent record."
              />
              {current.spans.length > 0 ? (
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium text-zinc-800">Keep cited quotes</legend>
                  {current.spans.map((s) => {
                    const key = `${s.sourceId}:${s.start}:${s.end}`;
                    return (
                      <div key={key}>
                        <input type="hidden" name="currentSpan" value={key} />
                        <Checkbox
                          id={`keep-${key}`}
                          name="keepSpan"
                          value={key}
                          defaultChecked
                          label={s.quote ? `“${s.quote.length > 120 ? `${s.quote.slice(0, 120)}…` : s.quote}”` : "Quote from a redacted source"}
                        />
                      </div>
                    );
                  })}
                  <p className="text-xs text-zinc-500">With no quotes left, the new version is recorded as entered manually by you.</p>
                </fieldset>
              ) : null}
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <Select name="addSourceId" label="Add a quote from" defaultValue="">
                  <option value="">No new quote</option>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {(s.title ?? s.filename ?? "Untitled source") + ` · ${formatDate(s.occurredAt, e.timeZone)}`}
                    </option>
                  ))}
                </Select>
                <Textarea name="addQuote" label="Exact quote" rows={2} maxLength={2000} hint="Copied exactly from the source; lengthen it if it appears more than once." />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Select id="revise-reason" name="reasonCode" label="Reason" defaultValue="new_information">
                  {Object.entries(REVISE_REASON_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
                <Textarea id="revise-note" name="note" label="Note (optional)" rows={2} maxLength={2000} />
              </div>
              <Button type="submit">Save new version</Button>
            </ActionForm>
          </Card>

          {canHaveDependencies ? (
            <Card title="Add a dependency" description="Items this one rests on. If one of them changes or is disputed, this item is flagged for review.">
              {dependencyChoices.length === 0 ? (
                <p className="text-sm text-zinc-500">No other active items to depend on.</p>
              ) : (
                <ActionForm action={addDependencyAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
                  {hidden}
                  <div className="flex-1">
                    <Select name="dependsOnItemId" label="Depends on" defaultValue="">
                      <option value="" disabled>
                        Choose an item
                      </option>
                      {dependencyChoices.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.shortId} · {i.statement.length > 90 ? `${i.statement.slice(0, 90)}…` : i.statement}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <Button type="submit" variant="secondary">
                    Add dependency
                  </Button>
                </ActionForm>
              )}
            </Card>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Supersede" description="Replace this item with another one (for example to change its kind).">
              <div className="space-y-4">
                {others.length > 0 ? (
                  <ActionForm action={supersedeItemAction} confirmMessage="Supersede this item? It leaves the agreed record." className="space-y-3">
                    {hidden}
                    <Select id="supersede-by" name="supersededByItemId" label="Replacement" defaultValue="">
                      <option value="" disabled>
                        Choose an item
                      </option>
                      {others.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.shortId} · {i.statement.length > 70 ? `${i.statement.slice(0, 70)}…` : i.statement}
                        </option>
                      ))}
                    </Select>
                    <Select id="supersede-reason" name="reasonCode" label="Reason" defaultValue="new_information">
                      {Object.entries(SUPERSEDE_REASON_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </Select>
                    <Textarea id="supersede-note" name="note" label="Note (optional)" rows={2} maxLength={2000} />
                    <Button type="submit" variant="secondary">
                      Supersede
                    </Button>
                  </ActionForm>
                ) : null}
                <Link href={`/engagements/${e.id}/items/new?supersedes=${item.id}`} className={buttonClasses("secondary", "sm")}>
                  Create a replacement item
                </Link>
              </div>
            </Card>

            <Card title="Withdraw" description="Remove this item from the agreed record. It stays in the history.">
              <ActionForm action={withdrawItemAction} confirmMessage="Withdraw this item?" className="space-y-3">
                {hidden}
                <Select id="withdraw-reason" name="reasonCode" label="Reason" defaultValue="out_of_scope">
                  {Object.entries(WITHDRAW_REASON_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
                <Textarea id="withdraw-note" name="note" label="Note (optional)" rows={2} maxLength={2000} />
                <Button type="submit" variant="danger">
                  Withdraw
                </Button>
              </ActionForm>
            </Card>
          </div>
        </section>
      ) : null}
    </div>
  );
}
