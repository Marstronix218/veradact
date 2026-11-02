// Date formatting in an engagement's time zone (falls back to UTC for an unknown zone).

function format(date: Date, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(date);
  }
}

export function formatDate(date: Date, timeZone: string): string {
  return format(date, timeZone, { dateStyle: "medium" });
}

export function formatDateTime(date: Date, timeZone: string): string {
  // dateStyle/timeStyle cannot be combined with timeZoneName.
  return format(date, timeZone, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}
