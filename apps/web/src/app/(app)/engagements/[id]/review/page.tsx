import type { Metadata } from "next";
import Link from "next/link";
import { listCandidates, listExtractionRuns, listSources, type CandidateView, type ExtractionRunRow } from "@veradact/core";
import { ActionForm, Badge, Button, buttonClasses, Card, EmptyState, Input, Notice, Select, Table, TBody, Td, Textarea, Th, THead, Tr } from "@/components";
import { requireEngagement, type EngagementView } from "@/lib/engagement";
import { formatDate, formatDateTime } from "@/lib/format";
import { KIND_LABELS, SOURCE_TYPE_LABELS } from "@/lib/labels";
import { withAuthTenant } from "@/lib/session";
import { rerunExtractionAction } from "../sources/actions";
import { WordDiff } from "../word-diff";
import { acceptCandidateAction, rejectCandidateAction } from "./actions";

export const metadata: Metadata = { title: "Review queue" };

type Search = { run?: string; extraction?: string; accepted?: string; version?: string; note?: string | string[] };

const NOTE_TEXT: Record<string, string> = {
  dependency_unresolved: "was not found (suggested dependencies on items that don't exist or weren't accepted are dropped)",
  dependency_not_active: "is superseded or withdrawn, so it was not added as a dependency",
  dependency_kind_not_allowed: "was not added: only decisions and requirements can depend on other items",
  dependency_cycle: "was not added because it would create a dependency cycle",
  revision_target_inactive: "is no longer active, so the suggestion was added as a new item instead of a revision",
};

function RunSummary({ run }: { run: ExtractionRunRow }) {
  if (run.status === "failed") {
    return (
      <Notice tone="error">
        AI extraction failed (<span className="font-mono text-xs">{run.errorCode ?? "unknown"}</span>). The source was added. Re-run extraction below or{" "}
        enter items manually.
      </Notice>
    );
  }
  if (run.status === "discarded") return <Notice>AI was switched off while extraction ran, so its suggestions were discarded.</Notice>;
  if (run.status === "running") return <Notice>AI extraction is still running.</Notice>;
  const stored = run.proposedCount - run.droppedCount;
  return (
    <Notice tone="success">
      <span data-testid="run-summary">
        AI proposed {run.proposedCount} {run.proposedCount === 1 ? "item" : "items"}: {stored} added to the queue, {run.droppedCount} dropped because the quote
        was not found in the source, {run.correctedCount} with corrected quote positions.
      </span>
    </Notice>
  );
}

function CandidateCard({ c, e }: { c: CandidateView; e: EngagementView }) {
  const suggested = c.suggestedDependencies.map((d) => d.ref).join(", ");
  return (
    <li className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4" data-testid="candidate">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="blue">{KIND_LABELS[c.kind]}</Badge>
        {c.verification === "exact" ? <Badge tone="green">Exact quote</Badge> : <Badge tone="yellow">Offset corrected</Badge>}
        {c.confidence !== null ? <span className="text-xs text-zinc-500">Confidence {Math.round(c.confidence * 100)}%</span> : null}
        <span className="font-mono text-xs text-zinc-400">#{c.ordinal}</span>
      </div>
      <p className="font-medium text-zinc-900" data-testid="candidate-statement">
        {c.statement}
      </p>
      {c.revises ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-800">
            Revises{" "}
            <Link href={`/engagements/${e.id}/items/${c.revises.shortId}`} className="font-mono hover:underline">
              {c.revises.shortId}
            </Link>{" "}
            (v{c.revises.currentVersion}, accepting creates v{c.revises.currentVersion + 1})
          </p>
          <WordDiff before={c.revises.statement} after={c.statement} />
        </div>
      ) : null}
      <blockquote className="border-l-2 border-zinc-300 pl-3 text-sm text-zinc-700">
        “{c.quote}”{c.speakerLabel ? <span className="ml-1 text-zinc-500">— {c.speakerLabel}</span> : null}
      </blockquote>
      {c.suggestedDependencies.length > 0 ? (
        <div className="text-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Suggested dependencies</p>
          <ul className="mt-1 space-y-0.5">
            {c.suggestedDependencies.map((d) => (
              <li key={d.ref} className="text-zinc-700">
                <span className="font-mono text-xs">{d.ref}</span>{" "}
                {d.target === null ? (
                  <span className="text-zinc-500">not found (will be dropped)</span>
                ) : d.target.type === "item" ? (
                  <span>{d.target.statement}</span>
                ) : (
                  <span>
                    {d.target.statement}{" "}
                    <span className="text-xs text-zinc-500">
                      {d.target.status === "accepted" ? "(accepted)" : d.target.status === "rejected" ? "(rejected, will be dropped)" : "(accept it first to link it)"}
                    </span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-wrap items-start gap-2">
        <ActionForm action={acceptCandidateAction}>
          <input type="hidden" name="engagementId" value={e.id} />
          <input type="hidden" name="candidateId" value={c.id} />
          <Button type="submit" size="sm">
            Accept
          </Button>
        </ActionForm>
        <ActionForm action={rejectCandidateAction}>
          <input type="hidden" name="engagementId" value={e.id} />
          <input type="hidden" name="candidateId" value={c.id} />
          <Button type="submit" size="sm" variant="secondary">
            Reject
          </Button>
        </ActionForm>
        <details className="w-full">
          <summary className="cursor-pointer text-sm font-medium text-zinc-700">Edit &amp; accept</summary>
          <ActionForm action={acceptCandidateAction} className="mt-3 space-y-3">
            <input type="hidden" name="engagementId" value={e.id} />
            <input type="hidden" name="candidateId" value={c.id} />
            <input type="hidden" name="mode" value="edit" />
            <Textarea
              id={`statement-${c.id}`}
              name="statement"
              label="Statement"
              rows={3}
              required
              maxLength={2000}
              defaultValue={c.statement}
              hint="Don't put personal data in statements: they become part of the permanent record."
            />
            <div className="grid gap-3 sm:grid-cols-2">
              {c.revises ? (
                <p className="text-sm text-zinc-600">Kind: {KIND_LABELS[c.kind]} (a revision keeps the item's kind)</p>
              ) : (
                <Select id={`kind-${c.id}`} name="kind" label="Kind" defaultValue={c.kind}>
                  {Object.entries(KIND_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              )}
              <Input id={`depends-${c.id}`} name="dependsOn" label="Depends on" defaultValue={suggested} placeholder="e.g. HALV-A3, #2" hint="Item ids or #n of suggestions from the same run." />
            </div>
            <Button type="submit" size="sm">
              Save and accept
            </Button>
          </ActionForm>
        </details>
      </div>
    </li>
  );
}

export default async function ReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const { id } = await params;
  const search = await searchParams;
  const e = await requireEngagement(id);
  const { groups, runs, sources } = await withAuthTenant(async (tx) => ({
    groups: await listCandidates(tx, e.id),
    runs: await listExtractionRuns(tx, e.id),
    sources: await listSources(tx, e.id),
  }));
  const run = search.run ? runs.find((r) => r.id === search.run) : undefined;
  const notes = (Array.isArray(search.note) ? search.note : search.note ? [search.note] : []).map((n) => {
    const at = n.indexOf(":");
    return { code: n.slice(0, at), ref: n.slice(at + 1) };
  });
  const total = groups.reduce((n, g) => n + g.candidates.length, 0);
  const latestRun = (sourceId: string) => runs.find((r) => r.sourceId === sourceId);
  const activeSources = sources.filter((s) => !s.redactedAt);

  return (
    <div className="space-y-6">
      {run ? <RunSummary run={run} /> : null}
      {search.extraction === "error" ? <Notice tone="error">AI extraction could not run. The source was added; re-run extraction below or enter items manually.</Notice> : null}
      {search.accepted ? (
        <Notice tone="success">
          <span data-testid="accepted-notice">
            Accepted as{" "}
            <Link href={`/engagements/${e.id}/items/${search.accepted}`} className="font-mono font-medium hover:underline">
              {search.accepted}
            </Link>
            {search.version && search.version !== "1" ? ` (new version ${search.version})` : ""}.
          </span>
          {notes.length > 0 ? (
            <ul className="mt-1 list-disc pl-5">
              {notes.map((n) => (
                <li key={`${n.code}:${n.ref}`}>
                  <span className="font-mono text-xs">{n.ref}</span> {NOTE_TEXT[n.code] ?? "was not applied"}
                </li>
              ))}
            </ul>
          ) : null}
        </Notice>
      ) : null}
      {!e.aiActive ? (
        <Notice>
          AI suggestions are off for this {e.orgAiEnabled ? "engagement" : "organization"}: no source text is sent to any model provider and extraction can&apos;t be
          re-run. Existing suggestions can still be reviewed.
        </Notice>
      ) : null}

      {total === 0 ? (
        <EmptyState
          title="No suggestions to review"
          description={e.aiActive ? "Add a source and AI will suggest items here. Nothing enters the ledger until you accept it." : "Enter items manually from the ledger."}
        >
          <Link href={`/engagements/${e.id}/items/new`} className={buttonClasses("secondary")}>
            Add item manually
          </Link>
        </EmptyState>
      ) : (
        groups.map((g) => (
          <section key={g.sourceId} className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold text-zinc-900">
                <Link href={`/engagements/${e.id}/sources/${g.sourceId}`} className="hover:underline">
                  {g.title ?? "Untitled source"}
                </Link>
                <span className="ml-2 text-sm font-normal text-zinc-500">
                  {g.sourceType ? SOURCE_TYPE_LABELS[g.sourceType] : ""}
                  {g.occurredAt ? ` · ${formatDate(g.occurredAt, e.timeZone)}` : ""} · {g.candidates.length} pending
                </span>
              </h2>
            </div>
            <ul className="space-y-3">
              {g.candidates.map((c) => (
                <CandidateCard key={c.id} c={c} e={e} />
              ))}
            </ul>
          </section>
        ))
      )}

      {activeSources.length > 0 ? (
        <Card title="Extraction by source" description="Re-running replaces a source's pending suggestions with new ones. Accepted and rejected suggestions stay as they are.">
          <Table>
            <THead>
              <Tr>
                <Th>Source</Th>
                <Th>Last run</Th>
                <Th className="text-right">Re-run</Th>
              </Tr>
            </THead>
            <TBody>
              {activeSources.map((s) => {
                const last = latestRun(s.id);
                return (
                  <Tr key={s.id}>
                    <Td className="font-medium text-zinc-900">{s.title ?? s.filename ?? "Untitled source"}</Td>
                    <Td className="text-zinc-600">
                      {last ? (
                        <>
                          {last.status === "succeeded"
                            ? `${last.proposedCount} proposed, ${last.droppedCount} dropped`
                            : last.status === "failed"
                              ? `Failed (${last.errorCode ?? "unknown"})`
                              : last.status === "discarded"
                                ? "Discarded (AI switched off)"
                                : "Running"}
                          <span className="ml-1 text-xs text-zinc-400">{formatDateTime(last.createdAt, e.timeZone)}</span>
                        </>
                      ) : (
                        "Never run"
                      )}
                    </Td>
                    <Td className="text-right">
                      <ActionForm action={rerunExtractionAction}>
                        <input type="hidden" name="engagementId" value={e.id} />
                        <input type="hidden" name="sourceId" value={s.id} />
                        <Button type="submit" size="sm" variant="secondary" disabled={!e.aiActive} title={e.aiActive ? undefined : "AI is off"}>
                          Re-run extraction
                        </Button>
                      </ActionForm>
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        </Card>
      ) : null}
    </div>
  );
}
