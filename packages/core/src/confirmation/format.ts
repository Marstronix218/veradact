// Date formatting for client pages and confirmation emails, always in the engagement time zone.

function format(date: Date, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(date);
  }
}

/** "Friday, November 13, 2026" */
export function formatLongDate(date: Date, timeZone: string): string {
  return format(date, timeZone, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

/** "Nov 13, 2026" */
export function formatShortDate(date: Date, timeZone: string): string {
  return format(date, timeZone, { year: "numeric", month: "short", day: "numeric" });
}

/** "Nov 13, 2026, 3:05 PM EST" */
export function formatDateTime(date: Date, timeZone: string): string {
  return format(date, timeZone, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
