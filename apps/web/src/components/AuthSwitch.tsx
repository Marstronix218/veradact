import Link from "next/link";

const TABS = [
  { key: "login", href: "/login", label: "Sign in" },
  { key: "signup", href: "/signup", label: "Create an account" },
] as const;

/** Sign in / Create an account switch above the auth card. Plain links, so it works without JavaScript. */
export function AuthSwitch({ current }: { current: "login" | "signup" }) {
  return (
    <nav aria-label="Account" className="mb-6 grid grid-cols-2 gap-1 rounded-lg border border-zinc-200 bg-zinc-100 p-1 text-sm">
      {TABS.map((tab) => {
        const active = tab.key === current;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-md px-3 py-2 text-center font-medium ${
              active ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-600 hover:text-zinc-900"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
