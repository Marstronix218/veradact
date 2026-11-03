import type { ReactNode } from "react";
import { DocumentCheckIcon } from "./icons";

export function EmptyState({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Optional call to action. */
  children?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 bg-white/60 px-6 py-12 text-center">
      <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-ink-50 text-ink-600 ring-1 ring-ink-100">
        <DocumentCheckIcon className="size-5" />
      </div>
      <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
      {description ? <p className="mx-auto mt-1 max-w-md text-sm text-zinc-600">{description}</p> : null}
      {children ? <div className="mt-4 flex justify-center">{children}</div> : null}
    </div>
  );
}
