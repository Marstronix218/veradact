"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  href: string;
  label: string;
  /** Match only the exact path (for index tabs such as /settings). */
  exact?: boolean;
}

/** Horizontal links with the current section highlighted. */
export function NavLinks({ items, variant = "top" }: { items: readonly NavItem[]; variant?: "top" | "tabs" }) {
  const pathname = usePathname();
  return (
    <nav className={variant === "top" ? "flex gap-1 overflow-x-auto" : "-mb-px flex gap-4 overflow-x-auto"}>
      {items.map((item) => {
        const active = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
        const className =
          variant === "top"
            ? `whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ${active ? "bg-zinc-100 text-zinc-900" : "text-zinc-600 hover:text-zinc-900"}`
            : `whitespace-nowrap border-b-2 px-1 pb-2 text-sm font-medium ${active ? "border-zinc-900 text-zinc-900" : "border-transparent text-zinc-500 hover:text-zinc-800"}`;
        return (
          <Link key={item.href} href={item.href} className={className} aria-current={active ? "page" : undefined}>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
