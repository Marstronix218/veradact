import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "green" | "yellow" | "red" | "blue" | "violet";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-zinc-100 text-zinc-700 ring-zinc-200",
  green: "bg-green-50 text-green-800 ring-green-200",
  yellow: "bg-amber-50 text-amber-800 ring-amber-200",
  red: "bg-red-50 text-red-800 ring-red-200",
  blue: "bg-blue-50 text-blue-800 ring-blue-200",
  violet: "bg-violet-50 text-violet-800 ring-violet-200",
};

/** `dot` adds a leading status dot in the tone's colour (use for item status). */
export function Badge({ tone = "neutral", dot = false, children }: { tone?: BadgeTone; dot?: boolean; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]}`}>
      {dot ? <span aria-hidden="true" className="size-1.5 rounded-full bg-current opacity-80" /> : null}
      {children}
    </span>
  );
}
