import { KIND_LETTER, type Kind } from "@veradact/core";
import { KIND_LABELS } from "@/lib/labels";

/** The kind's short-id letter (the R in HALV-R7) in an ink tile, then its label. */
export function KindChip({ kind }: { kind: Kind }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-zinc-700">
      <span
        aria-hidden="true"
        className="inline-flex size-5 items-center justify-center rounded-md bg-ink-50 font-mono text-[11px] font-semibold text-ink-700 ring-1 ring-inset ring-ink-100"
      >
        {KIND_LETTER[kind]}
      </span>
      {KIND_LABELS[kind]}
    </span>
  );
}
