import type { ReactNode } from "react";

export function Card({
  title,
  description,
  children,
  className = "",
}: {
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-zinc-200 bg-white p-5 shadow-xs ${className}`}>
      {title ? <h2 className="text-base font-semibold text-zinc-900">{title}</h2> : null}
      {description ? <p className="mt-1 text-sm text-zinc-600">{description}</p> : null}
      {children ? <div className={title || description ? "mt-4" : ""}>{children}</div> : null}
    </section>
  );
}
