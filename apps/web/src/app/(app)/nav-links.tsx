"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  href: string;
  label: string;
  /** Match only the exact path (for index tabs such as /settings). */
  exact?: boolean;
  /** Further path prefixes that also mark this item active (e.g. item pages under the ledger tab). */
  alsoActiveFor?: readonly string[];
  /** A count shown as a pill after the label (e.g. unread notifications); hidden when 0. */
  badge?: number;
}

/** Horizontal links with the current section highlighted. */
export function NavLinks({ items, variant = "top" }: { items: readonly NavItem[]; variant?: "top" | "tabs" }) {
  const pathname = usePathname();
  return (
    <nav className={variant === "top" ? "flex gap-1 overflow-x-auto" : "-mb-px flex gap-4 overflow-x-auto"}>
      {items.map((item) => {
        const active =
          (item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`)) ||
          (item.alsoActiveFor ?? []).some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
        const className =
          variant === "top"
            ? `whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ${active ? "bg-ink-50 text-ink-900" : "text-zinc-600 hover:bg-zinc-100/70 hover:text-zinc-900"}`
            : `whitespace-nowrap border-b-2 px-1 pb-2 text-sm font-medium ${active ? "border-ink-900 text-ink-950" : "border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-800"}`;
        return (
          <Link key={item.href} href={item.href} className={className} aria-current={active ? "page" : undefined}>
            {item.label}
            {item.badge ? (
              <span className="ml-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white" data-testid="nav-badge">
                {item.badge}
                <span className="sr-only"> unread</span>
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
