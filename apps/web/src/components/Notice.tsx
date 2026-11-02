import type { ReactNode } from "react";

export type NoticeTone = "info" | "success" | "error";

const TONES: Record<NoticeTone, string> = {
  info: "border-zinc-200 bg-zinc-50 text-zinc-800",
  success: "border-green-200 bg-green-50 text-green-900",
  error: "border-red-200 bg-red-50 text-red-900",
};

/** Inline status message (form results, errors). */
export function Notice({ tone = "info", children }: { tone?: NoticeTone; children: ReactNode }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`rounded-md border px-4 py-3 text-sm ${TONES[tone]}`}>
      {children}
    </div>
  );
}
