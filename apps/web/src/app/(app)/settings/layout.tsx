import type { ReactNode } from "react";
import { PageHeader } from "@/components";
import { NavLinks, type NavItem } from "../nav-links";

const TABS: NavItem[] = [
  { href: "/settings", label: "Organization", exact: true },
  { href: "/settings/users", label: "Users" },
  { href: "/settings/api-tokens", label: "API tokens" },
];

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PageHeader title="Settings" />
      <div className="mb-6 border-b border-zinc-200">
        <NavLinks items={TABS} variant="tabs" />
      </div>
      {children}
    </>
  );
}
