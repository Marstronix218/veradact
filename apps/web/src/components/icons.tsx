// Inline icons (24×24, stroke = currentColor). Decorative: the text next to them carries the meaning.
import type { ReactNode } from "react";

function Icon({ className = "size-4", children }: { className?: string; children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 ${className}`}>
      {children}
    </svg>
  );
}

export function ShieldCheckIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.9 7.5-9.5V6L12 3Z" />
      <path d="m8.8 12 2.2 2.2 4.3-4.4" />
    </Icon>
  );
}

export function ShieldAlertIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.9 7.5-9.5V6L12 3Z" />
      <path d="M12 8v4.5" />
      <path d="M12 16h.01" />
    </Icon>
  );
}

/** A page of text with a check: the default for empty states. */
export function DocumentCheckIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
      <path d="M14 3v5h5" />
      <path d="m9 14.5 2 2 4-4" />
    </Icon>
  );
}
