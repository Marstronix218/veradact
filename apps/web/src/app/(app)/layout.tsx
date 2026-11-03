import Link from "next/link";
import type { ReactNode } from "react";
import { getCurrentUser, unreadCount } from "@veradact/core";
import { withTenant } from "@veradact/db";
import { Button, Wordmark } from "@/components";
import { getDb } from "@/lib/db";
import { requireAuth } from "@/lib/session";
import { NavLinks, type NavItem } from "./nav-links";

const NAV: NavItem[] = [
  { href: "/engagements", label: "Engagements" },
  { href: "/metrics", label: "Metrics" },
  { href: "/notifications", label: "Notifications" },
  { href: "/settings", label: "Settings" },
];

/** Every page under (app) requires a session. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const auth = await requireAuth();
  const user = await getCurrentUser(getDb(), auth);
  const unread = await withTenant(getDb(), { orgId: auth.orgId, userId: auth.userId }, (tx) => unreadCount(tx, auth.userId));
  const nav = NAV.map((item) => (item.href === "/notifications" ? { ...item, badge: unread } : item));

  return (
    <div className="min-h-screen">
      <header className="z-10 border-b border-zinc-200/80 bg-white/90 backdrop-blur sm:sticky sm:top-0">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/engagements" className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink-600">
            <Wordmark />
          </Link>
          <NavLinks items={nav} />
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-sm text-zinc-600 sm:inline" data-testid="current-user-email">
              {user.email}
            </span>
            <form action="/logout" method="post">
              <Button type="submit" variant="secondary" size="sm">
                Log out
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
