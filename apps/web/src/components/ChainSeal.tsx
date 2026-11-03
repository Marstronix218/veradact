import Link from "next/link";
import type { ChainVerification } from "@veradact/core";
import { shortHash } from "@/lib/format";
import { ShieldAlertIcon, ShieldCheckIcon } from "./icons";

/**
 * Compact result of re-hashing an engagement's log (`verifyEngagementChain`), linking to the
 * export page where the full result and the record live. Only render it for a verification that
 * actually ran on this request.
 */
export function ChainSeal({ verification, href }: { verification: Pick<ChainVerification, "ok" | "checked" | "headHash">; href: string }) {
  const { ok, checked, headHash } = verification;
  return (
    <Link
      href={href}
      title={ok ? `Every event re-hashed and linked. Head ${headHash}` : "The hash chain does not verify. Open Export for details."}
      className={`inline-flex items-center gap-2.5 rounded-lg px-3 py-2 ring-1 ring-inset transition-colors ${
        ok ? "bg-green-50/60 text-green-900 ring-green-200 hover:bg-green-50" : "bg-red-50 text-red-900 ring-red-200 hover:bg-red-100/60"
      }`}
    >
      {ok ? <ShieldCheckIcon className="size-5 text-green-700" /> : <ShieldAlertIcon className="size-5 text-red-700" />}
      <span className="leading-tight">
        <span className="block text-sm font-semibold">{ok ? "Chain verified" : "Chain check failed"}</span>
        <span className="block text-xs opacity-80">
          {checked} {checked === 1 ? "event" : "events"}
          {ok ? "" : " verified before the failure"} · <span className="font-mono">{shortHash(headHash)}</span>
        </span>
      </span>
    </Link>
  );
}
