import type { ItemStatus } from "@veradact/core";

/** Fill colour per status, shared by the bar and the legends next to it. */
export const STATUS_FILL: Record<ItemStatus, string> = { confirmed: "bg-green-600", pending: "bg-blue-400", disputed: "bg-red-500" };

const ORDER: readonly ItemStatus[] = ["confirmed", "pending", "disputed"];

/** Share of confirmed / pending / disputed items as one segmented bar. */
export function ConfirmationBar({ counts, className = "h-2.5" }: { counts: Record<ItemStatus, number>; className?: string }) {
  const total = ORDER.reduce((sum, s) => sum + counts[s], 0);
  const label = total === 0 ? "No items" : ORDER.map((s) => `${counts[s]} ${s}`).join(", ");
  return (
    <div role="img" aria-label={label} className={`flex w-full gap-0.5 overflow-hidden rounded-full bg-zinc-100 ${className}`}>
      {total === 0
        ? null
        : ORDER.filter((s) => counts[s] > 0).map((s) => <span key={s} className={STATUS_FILL[s]} style={{ width: `${(counts[s] / total) * 100}%` }} />)}
    </div>
  );
}
