import type { ReactNode } from "react";
import { Badge } from "@/components";
import { requireEngagement } from "@/lib/engagement";
import { NavLinks, type NavItem } from "../../nav-links";

/** Header (name, client, short code, AI badge) and sub-navigation for every engagement page. */
export default async function EngagementLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const e = await requireEngagement(id);
  const base = `/engagements/${e.id}`;
  const tabs: NavItem[] = [
    { href: base, label: "Ledger", exact: true, alsoActiveFor: [`${base}/items`] },
    { href: `${base}/review`, label: "Review queue" },
    { href: `${base}/sources`, label: "Sources" },
    { href: `${base}/contacts`, label: "Contacts" },
    { href: `${base}/confirmations`, label: "Confirmations" },
    { href: `${base}/replay`, label: "Replay" },
    { href: `${base}/export`, label: "Export" },
    { href: `${base}/settings`, label: "Settings" },
  ];

  return (
    <>
      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="font-display text-3xl font-semibold text-ink-950" data-testid="engagement-name">
            {e.name}
          </h1>
          <span className="rounded-md bg-white px-1.5 py-0.5 font-mono text-xs font-medium text-zinc-600 ring-1 ring-inset ring-zinc-200">{e.shortCode}</span>
          {e.aiActive ? (
            <Badge tone="violet">AI on</Badge>
          ) : (
            <Badge tone="neutral">{e.orgAiEnabled ? "AI off" : "AI off (organization)"}</Badge>
          )}
          {e.status === "archived" ? <Badge>Archived</Badge> : null}
        </div>
        <p className="mt-1 text-sm text-zinc-600">{e.clientName}</p>
      </div>
      <div className="mb-6 border-b border-zinc-200">
        <NavLinks items={tabs} variant="tabs" />
      </div>
      {children}
    </>
  );
}
