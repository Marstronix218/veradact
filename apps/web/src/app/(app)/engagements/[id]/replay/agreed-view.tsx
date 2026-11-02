import Link from "next/link";
import type { AgreedView, Confirmation } from "@veradact/core";
import { Badge, EmptyState, Table, TBody, Td, Th, THead, Tr } from "@/components";
import { formatDate } from "@/lib/format";
import { KIND_LABELS, STATUS_LABELS, STATUS_TONES } from "@/lib/labels";
import type { ReplayContext } from "./known-view";

function Confirmers({ confirmations, ctx }: { confirmations: Confirmation[]; ctx: ReplayContext }) {
  if (confirmations.length === 0) return <span className="text-zinc-500">None recorded</span>;
  return (
    <ul className="space-y-0.5">
      {confirmations.map((c) => (
        <li key={c.seq} className="whitespace-nowrap">
          {ctx.contactName(c.contactId, c.contactErased)} <span className="text-zinc-500">· {formatDate(c.recordedAt, ctx.timeZone)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Items agreed at T (current version confirmed, active) at the confirmed version, and, separately,
 * items whose earlier version was agreed but which were under revision at T (D-010).
 */
export function AgreedSection({ view, ctx }: { view: AgreedView; ctx: ReplayContext }) {
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-base font-semibold text-zinc-900">Agreed at this time</h2>
        {view.items.length === 0 ? (
          <EmptyState title="Nothing was agreed at this time" description="No item's current version had been confirmed by the client yet." />
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>Id</Th>
                <Th>Kind</Th>
                <Th>Agreed statement</Th>
                <Th>Version</Th>
                <Th>Confirmed by</Th>
              </Tr>
            </THead>
            <TBody>
              {view.items.map((item) => (
                <Tr key={item.itemId} data-testid="agreed-row" data-short-id={item.shortId}>
                  <Td className="whitespace-nowrap align-top">
                    <Link href={`${ctx.base}/items/${item.shortId}`} className="font-mono text-xs font-medium text-zinc-900 hover:underline">
                      {item.shortId}
                    </Link>
                  </Td>
                  <Td className="whitespace-nowrap align-top text-zinc-600">{KIND_LABELS[item.kind]}</Td>
                  <Td className="max-w-xl align-top">
                    <p>{item.statement}</p>
                    {item.needsReview ? (
                      <p className="mt-1">
                        <Badge tone="yellow">
                          Needs review: {[...new Set(item.reviewReasons.map((r) => r.upstreamShortId ?? "upstream"))].join(", ")} changed
                        </Badge>
                      </p>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap align-top text-zinc-600">
                    v{item.version}
                    <span className="ml-1 font-mono text-xs" title={item.contentHash}>
                      #{item.contentHash.slice(0, 12)}
                    </span>
                  </Td>
                  <Td className="align-top text-sm">
                    <Confirmers confirmations={item.confirmations} ctx={ctx} />
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold text-zinc-900">Previously agreed, under revision at this time</h2>
          <p className="mt-1 text-sm text-zinc-600">
            An earlier version was confirmed, but the item had been revised and the new version was not confirmed yet. These are not part of the agreement at this time and are shown for context only.
          </p>
        </div>
        {view.previouslyAgreed.length === 0 ? (
          <p className="text-sm text-zinc-500">None.</p>
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>Id</Th>
                <Th>Previously agreed version</Th>
                <Th>Confirmed by</Th>
                <Th>Version at this time</Th>
              </Tr>
            </THead>
            <TBody>
              {view.previouslyAgreed.map((item) => (
                <Tr key={item.itemId} data-testid="previously-agreed-row" data-short-id={item.shortId}>
                  <Td className="whitespace-nowrap align-top">
                    <Link href={`${ctx.base}/items/${item.shortId}`} className="font-mono text-xs font-medium text-zinc-900 hover:underline">
                      {item.shortId}
                    </Link>
                  </Td>
                  <Td className="max-w-md align-top">
                    <p>{item.agreedStatement}</p>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      v{item.agreedVersion} <span className="font-mono">#{item.agreedContentHash.slice(0, 12)}</span>
                    </p>
                  </Td>
                  <Td className="align-top text-sm">
                    <Confirmers confirmations={item.confirmations} ctx={ctx} />
                  </Td>
                  <Td className="max-w-md align-top">
                    <p>{item.currentStatement}</p>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      v{item.currentVersion} <Badge tone={STATUS_TONES[item.currentStatus]}>{STATUS_LABELS[item.currentStatus]}</Badge>
                    </p>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </section>
    </div>
  );
}
