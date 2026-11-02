import Link from "next/link";
import type { DecisionContext } from "@veradact/core";
import { Badge, Card, Table, TBody, Td, Th, THead, Tr } from "@/components";
import { formatDate, formatDateTime } from "@/lib/format";
import { KIND_LABELS, LIFECYCLE_LABELS, STATUS_LABELS, STATUS_TONES } from "@/lib/labels";
import { KnownItemsTable, type ReplayContext } from "./known-view";
import { replayHref } from "./params";

/**
 * "What did we know when this was decided?" (ARCHITECTURE §5.4): the known view folded through the
 * seq of the event that recorded this version, plus each dependency's version and status then.
 */
export function DecisionContextSection({ context, versions, ctx }: { context: DecisionContext; versions: number[]; ctx: ReplayContext }) {
  const { item, known } = context;
  return (
    <div className="space-y-6" data-testid="decision-context">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-zinc-900">
          What did we know when{" "}
          <Link href={`${ctx.base}/items/${context.shortId}`} className="font-mono hover:underline">
            {context.shortId}
          </Link>{" "}
          version {context.version} was decided?
        </h2>
        <p className="text-sm text-zinc-600">
          {KIND_LABELS[context.kind]} version {context.version} was recorded on {formatDateTime(context.recordedAt, ctx.timeZone)} (log seq {context.seq})
          {context.occurredAt.getTime() !== context.recordedAt.getTime() ? `; it was said on ${formatDate(context.occurredAt, ctx.timeZone)}` : ""}. Everything below is the
          ledger exactly as it stood after that event.
        </p>
        {versions.length > 1 ? (
          <p className="flex flex-wrap items-center gap-2 text-sm text-zinc-600">
            Other versions:
            {versions.map((v) =>
              v === context.version ? (
                <span key={v} className="font-semibold text-zinc-900">
                  v{v}
                </span>
              ) : (
                <Link key={v} href={replayHref(ctx.base, { decision: context.shortId, version: v })} className="text-blue-700 hover:underline">
                  v{v}
                </Link>
              ),
            )}
          </p>
        ) : null}
        <p className="break-all text-xs text-zinc-500" data-testid="replay-head">
          Log head at that moment: seq {known.head.seq} · <span className="font-mono">{known.head.hash}</span>
        </p>
      </div>

      <Card title="The item at that moment">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONES[item.status]}>{STATUS_LABELS[item.status]}</Badge>
            {item.lifecycle !== "active" ? <Badge>{LIFECYCLE_LABELS[item.lifecycle]}</Badge> : null}
            {item.needsReview ? <Badge tone="yellow">Needs review</Badge> : null}
            <span className="font-mono text-xs text-zinc-500" title={item.current.contentHash}>
              #{item.current.contentHash.slice(0, 12)}
            </span>
          </div>
          <p className="text-zinc-900" data-testid="context-statement">
            {item.current.statement}
          </p>
        </div>
      </Card>

      <section className="space-y-3">
        <h3 className="text-base font-semibold text-zinc-900">What it depended on at that moment</h3>
        {context.dependencies.length === 0 ? (
          <p className="text-sm text-zinc-500">It did not depend on any other item at that moment.</p>
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>Id</Th>
                <Th>Kind</Th>
                <Th>Statement then</Th>
                <Th>Version</Th>
                <Th>Status then</Th>
              </Tr>
            </THead>
            <TBody>
              {context.dependencies.map((d) => (
                <Tr key={d.itemId} data-testid="context-dependency" data-short-id={d.shortId ?? ""}>
                  <Td className="whitespace-nowrap align-top font-mono text-xs">{d.shortId ?? "unknown"}</Td>
                  <Td className="whitespace-nowrap align-top text-zinc-600">{d.kind ? KIND_LABELS[d.kind] : ""}</Td>
                  <Td className="max-w-xl align-top">{d.statement ?? ""}</Td>
                  <Td className="align-top text-zinc-600">{d.version !== null ? `v${d.version}` : ""}</Td>
                  <Td className="space-x-1 align-top">
                    {d.status ? <Badge tone={STATUS_TONES[d.status]}>{STATUS_LABELS[d.status]}</Badge> : null}
                    {d.lifecycle && d.lifecycle !== "active" ? <Badge>{LIFECYCLE_LABELS[d.lifecycle]}</Badge> : null}
                    {d.needsReview ? <Badge tone="yellow">Needs review</Badge> : null}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-base font-semibold text-zinc-900">Everything known at that moment</h3>
        <KnownItemsTable items={known.items} ctx={ctx} emptyText="No items were recorded yet." />
      </section>
    </div>
  );
}
