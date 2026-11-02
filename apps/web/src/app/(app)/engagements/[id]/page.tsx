import type { Metadata } from "next";
import Link from "next/link";
import { listItems, type ItemListFilters, type ItemLifecycle, type ItemStatus, type Kind } from "@veradact/core";
import { Badge, Button, buttonClasses, EmptyState, Select, Table, TBody, Td, Th, THead, Tr } from "@/components";
import { requireEngagement } from "@/lib/engagement";
import { formatDate } from "@/lib/format";
import { enumValue, KIND_LABELS, LIFECYCLE_LABELS, STATUS_LABELS, STATUS_TONES } from "@/lib/labels";
import { withAuthTenant } from "@/lib/session";

export const metadata: Metadata = { title: "Ledger" };

type Search = { kind?: string; status?: string; lifecycle?: string; review?: string };

export default async function LedgerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const { id } = await params;
  const search = await searchParams;
  const e = await requireEngagement(id);

  const kind = enumValue<Kind>(KIND_LABELS, search.kind);
  const status = enumValue<ItemStatus>(STATUS_LABELS, search.status);
  // Active items by default; `lifecycle=all` shows superseded and withdrawn ones too.
  const lifecycleParam = search.lifecycle ?? "active";
  const lifecycle = enumValue<ItemLifecycle>(LIFECYCLE_LABELS, lifecycleParam);
  const needsReview = search.review === "1";
  const filters: ItemListFilters = {
    ...(kind ? { kind } : {}),
    ...(status ? { status } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ...(needsReview ? { needsReview: true } : {}),
  };
  const items = await withAuthTenant((tx) => listItems(tx, e.id, filters));
  const base = `/engagements/${e.id}`;
  const filtered = Boolean(kind || status || needsReview || lifecycleParam !== "active");

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <form method="get" className="flex flex-wrap items-end gap-3" aria-label="Filter items">
          <div className="w-40">
            <Select name="kind" label="Kind" defaultValue={kind ?? ""}>
              <option value="">All kinds</option>
              {Object.entries(KIND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-36">
            <Select name="status" label="Status" defaultValue={status ?? ""}>
              <option value="">All statuses</option>
              {Object.entries(STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-36">
            <Select name="lifecycle" label="Lifecycle" defaultValue={lifecycle ?? "all"}>
              {Object.entries(LIFECYCLE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
              <option value="all">All</option>
            </Select>
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm text-zinc-800">
            <input type="checkbox" name="review" value="1" defaultChecked={needsReview} className="size-4 rounded border-zinc-300" />
            Needs review
          </label>
          <Button type="submit" variant="secondary">
            Filter
          </Button>
          {filtered ? (
            <Link href={base} className="pb-2 text-sm text-zinc-600 hover:underline">
              Clear
            </Link>
          ) : null}
        </form>
        <div className="flex gap-2">
          <Link href={`${base}/sources/new`} className={buttonClasses("secondary")}>
            Add source
          </Link>
          <Link href={`${base}/items/new`} className={buttonClasses()}>
            Add item
          </Link>
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState
          title={filtered ? "No items match these filters" : "No items yet"}
          description={
            filtered
              ? "Try a different filter."
              : e.aiActive
                ? "Add a source: AI suggestions land in the review queue, and nothing enters the ledger until you accept it."
                : "Add a source, then enter items manually. AI suggestions are off for this engagement."
          }
        />
      ) : (
        <Table>
          <THead>
            <Tr>
              <Th>Id</Th>
              <Th>Kind</Th>
              <Th>Statement</Th>
              <Th>Status</Th>
              <Th>Version</Th>
              <Th>Review</Th>
              <Th>Updated</Th>
            </Tr>
          </THead>
          <TBody>
            {items.map((item) => (
              <Tr key={item.id} data-testid="ledger-row">
                <Td className="whitespace-nowrap">
                  <Link href={`${base}/items/${item.shortId}`} className="font-mono text-xs font-medium text-zinc-900 hover:underline">
                    {item.shortId}
                  </Link>
                </Td>
                <Td className="whitespace-nowrap text-zinc-600">{KIND_LABELS[item.kind]}</Td>
                <Td className="max-w-xl">
                  <Link href={`${base}/items/${item.shortId}`} className="line-clamp-2 hover:underline">
                    {item.statement}
                  </Link>
                  {item.lifecycle !== "active" ? <span className="mt-1 block text-xs text-zinc-500">{LIFECYCLE_LABELS[item.lifecycle]}</span> : null}
                </Td>
                <Td>
                  <Badge tone={STATUS_TONES[item.status]}>{STATUS_LABELS[item.status]}</Badge>
                </Td>
                <Td className="text-zinc-600">v{item.currentVersion}</Td>
                <Td>{item.needsReview ? <Badge tone="yellow">Needs review</Badge> : null}</Td>
                <Td className="whitespace-nowrap text-zinc-600">{formatDate(item.updatedAt, e.timeZone)}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
