/** The Veradact mark: a V drawn as a check, on an ink tile. Decorative; pair it with the name. */
export function BrandMark({ className = "size-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={`shrink-0 ${className}`}>
      <rect width="24" height="24" rx="6" className="fill-ink-900" />
      <path d="M6.8 8.2 11.1 16.6 17.6 6.2" fill="none" stroke="white" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Mark plus name. `size="lg"` for the sign-in pages. */
export function Wordmark({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span className={`inline-flex items-center ${size === "lg" ? "gap-2.5" : "gap-2"}`}>
      <BrandMark className={size === "lg" ? "size-8" : "size-6"} />
      <span className={`font-display font-semibold text-ink-950 ${size === "lg" ? "text-3xl" : "text-xl"}`}>Veradact</span>
    </span>
  );
}
