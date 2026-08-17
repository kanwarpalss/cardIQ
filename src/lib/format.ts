// Single home for money/number/date formatting (ARCH-04 — one source of truth).

export const fmtINR = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
export const fmtNum = (n: number) => Math.round(n).toLocaleString("en-IN");

export const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Whole days from today (local midnight) to the given YYYY-MM-DD. Negative = past.
 * `now` is injectable so expiry logic can be tested against fixed dates instead
 * of the wall clock — callers in the app omit it and get the real today.
 */
export function daysUntil(dateStr: string, now: Date = new Date()): number {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + "T00:00:00");
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

/** "12 Mar 2027" — compact human date for chips and expiry lines. */
export function fmtDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Start of the card's CURRENT anniversary year — the window annual/quarterly
 * milestones reset on. Without a card anniversary_date, falls back to
 * calendar-year start (labeled as an approximation by the caller).
 */
export function anniversaryWindowStart(anniversaryDate: string | null, now: Date = new Date()): Date {
  if (!anniversaryDate) return new Date(now.getFullYear(), 0, 1);
  const anniv = new Date(anniversaryDate + "T00:00:00");
  const month = anniv.getMonth();
  const day = anniv.getDate();
  let start = new Date(now.getFullYear(), month, day);
  if (start.getTime() > now.getTime()) {
    start = new Date(now.getFullYear() - 1, month, day);
  }
  return start;
}
