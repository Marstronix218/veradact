import Link from "next/link";
import type { KnownItem, VersionView } from "@veradact/core";
import { Badge, EmptyState, Table, TBody, Td, Th, THead, Tr } from "@/components";
import { formatDateTime } from "@/lib/format";
import { KIND_LABELS, LIFECYCLE_LABELS, REVISE_REASON_LABELS, STATUS_LABELS, STATUS_TONES } from "@/lib/labels";
import { WordDiff } from "../word-diff";
import { replayHref } from "./params";

export interface ReplayContext {
  /** `/engagements/<id>` */
  base: string;
  timeZone: string;
  /** Contact name now ("Erased contact" once erased). */
  contactName: (contactId: string, erasedAtView: boolean) => string;
}

/** Decisions and requirements get the "What did we know when this was decided?" link. */
export function hasDecisionContext(kind: KnownItem["kind"]): boolean {
  return kind === "decision" || kind === "requirement";
}

function VersionsRecorded({ item, ctx }: { item: KnownItem; ctx: ReplayContext }) {
  return (
    <ol className="mt-2 space-y-3 border-l-2 border-zinc-200 pl-3">
      {[...item.versions].reverse().map((v: VersionView) => {
        const previous = item.versions.find((p) => p.version === v.version - 1);
        return (
          <li key={v.version} className="space-y-1" data-testid="replay-version">
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <span className="font-semibold text-zinc-800">v{v.version}</span>
              <Badge tone={STATUS_TONES[v.status]}>{STATUS_LABELS[v.status]}</Badge>
              <span>recorded {formatDateTime(v.recordedAt, ctx.timeZone)}</span>
              {v.reasonCode ? <span>· {REVISE_REASON_LABELS[v.reasonCode]}</span> : null}
              <span className="font-mono" title={v.contentHash}>
                #{v.contentHash.slice(0, 12)}
              </span>
            </div>
            {previous ? <WordDiff before={previous.statement} after={v.statement} /> : <p className="text-sm text-zinc-800">{v.statement}</p>}
            {v.responses.length > 0 ? (
              <ul className="text-xs text-zinc-600">
                {v.responses.map((r) => (
                  <li key={r.seq}>
                    {ctx.contactName(r.contactId, r.contactErased)} {r.response} on {formatDateTime(r.recordedAt, ctx.timeZone)}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** Items as known at a point in time: version, status, lifecycle and needs-review at that time. */
export function KnownItemsTable({ items, ctx, emptyText }: { items: KnownItem[]; ctx: ReplayContext; emptyText: string }) {
  if (items.length === 0) return <EmptyState title={emptyText} />;
  return (
    <Table>
      <THead>
        <Tr>
          <Th>Id</Th>
          <Th>Kind</Th>
          <Th>Statement at that time</Th>
          <Th>Status</Th>
          <Th>Version</Th>
          <Th>State</Th>
        </Tr>
      </THead>
      <TBody>
        {items.map((item) => (
          <Tr key={item.itemId} data-testid="replay-row" data-short-id={item.shortId}>
            <Td className="whitespace-nowrap align-top">
              <Link href={`${ctx.base}/items/${item.shortId}`} className="font-mono text-xs font-medium text-zinc-900 hover:underline" title="Open the item as it is now">
                {item.shortId}
              </Link>
            </Td>
            <Td className="whitespace-nowrap align-top text-zinc-600">{KIND_LABELS[item.kind]}</Td>
            <Td className="max-w-xl align-top">
              <p>{item.current.statement}</p>
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-800">
                  {item.versions.length === 1 ? "1 version" : `${item.versions.length} versions`} recorded by then
                </summary>
                <VersionsRecorded item={item} ctx={ctx} />
              </details>
              {hasDecisionContext(item.kind) ? (
                <Link
                  href={replayHref(ctx.base, { decision: item.shortId, version: item.currentVersion })}
                  className="mt-1 inline-block text-xs text-blue-700 hover:underline"
                >
                  What did we know when this was decided?
                </Link>
              ) : null}
            </Td>
            <Td className="align-top" data-testid="replay-status">
              <Badge tone={STATUS_TONES[item.status]}>{STATUS_LABELS[item.status]}</Badge>
            </Td>
            <Td className="align-top text-zinc-600">v{item.currentVersion}</Td>
            <Td className="space-y-1 align-top text-xs text-zinc-600">
              {item.lifecycle !== "active" ? (
                <p>
                  {LIFECYCLE_LABELS[item.lifecycle]}
                  {item.supersededByShortId ? ` by ${item.supersededByShortId}` : ""}
                </p>
              ) : null}
              {item.needsReview ? (
                <Badge tone="yellow">
                  Needs review{item.reviewReasons.length > 0 ? `: ${[...new Set(item.reviewReasons.map((r) => r.upstreamShortId ?? "upstream"))].join(", ")}` : ""}
                </Badge>
              ) : null}
              {item.lifecycle === "active" && !item.needsReview ? <span>Active</span> : null}
            </Td>
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}
