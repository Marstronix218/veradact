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
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900" data-testid="engagement-name">
            {e.name}
          </h1>
          <span className="font-mono text-xs text-zinc-500">{e.shortCode}</span>
          {e.aiActive ? (
            <Badge tone="blue">AI on</Badge>
          ) : (
            <Badge tone="neutral">{e.orgAiEnabled ? "AI off" : "AI off (organization)"}</Badge>
          )}
          {e.status === "archived" ? <Badge tone="yellow">Archived</Badge> : null}
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
