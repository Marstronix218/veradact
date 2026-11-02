import type { ReactNode } from "react";

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
    <div className="rounded-lg border border-dashed border-zinc-300 bg-white px-6 py-12 text-center">
      <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
      {description ? <p className="mx-auto mt-1 max-w-md text-sm text-zinc-600">{description}</p> : null}
      {children ? <div className="mt-4 flex justify-center">{children}</div> : null}
    </div>
  );
}
