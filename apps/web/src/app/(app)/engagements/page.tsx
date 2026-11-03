import type { Metadata } from "next";
import Link from "next/link";
import { getEngagementSummary } from "@veradact/core";
import { Badge, buttonClasses, ConfirmationBar, EmptyState, PageHeader } from "@/components";
import { withAuthTenant } from "@/lib/session";

export const metadata: Metadata = { title: "Engagements" };

function formatDate(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export default async function EngagementsPage() {
  const engagements = await withAuthTenant(async (tx) => {
    const rows = await tx.query.engagement.findMany({
      columns: { id: true, name: true, clientName: true, shortCode: true, status: true, timeZone: true, createdAt: true },
      orderBy: (e, { asc, desc }) => [asc(e.status), desc(e.createdAt)],
    });
    // One summary per engagement: fine for pilot orgs with a handful of engagements.
    return Promise.all(rows.map(async (e) => ({ ...e, items: (await getEngagementSummary(tx, e.id))?.items })));
  });

  // The form lives at /engagements/new (core's createEngagement command).
  const newEngagement = (
    <Link href="/engagements/new" className={buttonClasses()}>
      New engagement
    </Link>
  );

  return (
    <>
      <PageHeader
        title="Engagements"
        description="Each engagement is one client project with its own ledger."
        actions={newEngagement}
      />
      {engagements.length === 0 ? (
        <EmptyState
          title="No engagements yet"
          description="Create an engagement for a client project, then add sources and items to its ledger."
        >
          {newEngagement}
        </EmptyState>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {engagements.map((e) => (
            <li key={e.id}>
              <Link
                href={`/engagements/${e.id}`}
                className={`group flex h-full flex-col rounded-xl border p-5 shadow-xs transition hover:border-ink-200 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-600 ${
                  e.status === "archived" ? "border-dashed border-zinc-300 bg-zinc-50" : "border-zinc-200/80 bg-white"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded-md bg-zinc-50 px-1.5 py-0.5 font-mono text-xs font-medium text-zinc-600 ring-1 ring-inset ring-zinc-200">
                    {e.shortCode}
                  </span>
                  <Badge tone={e.status === "active" ? "green" : "neutral"}>{e.status === "active" ? "Active" : "Archived"}</Badge>
                </div>
                <h2 className="mt-3 font-display text-xl font-semibold leading-snug text-ink-950 group-hover:text-ink-700">{e.name}</h2>
                <p className="mt-0.5 text-sm text-zinc-600">{e.clientName}</p>
                <div className="mt-auto pt-6">
                  {e.items ? <ConfirmationBar counts={e.items.byStatus} className="h-1.5" /> : null}
                  <div className="mt-2 flex flex-wrap justify-between gap-x-3 text-xs text-zinc-500">
                    <span>
                      {!e.items || e.items.total === 0
                        ? "No items yet"
                        : e.items.active === 0
                          ? "No active items"
                          : `${e.items.byStatus.confirmed} of ${e.items.active} confirmed${e.items.byStatus.disputed > 0 ? ` · ${e.items.byStatus.disputed} disputed` : ""}`}
                    </span>
                    <span>Created {formatDate(e.createdAt, e.timeZone)}</span>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
