// Single home for money/number/date formatting (ARCH-04 — one source of truth).

export const fmtINR = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
export const fmtNum = (n: number) => Math.round(n).toLocaleString("en-IN");

export const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Whole days from today (local midnight) to the given YYYY-MM-DD. Negative = past. */
export function daysUntil(dateStr: string): number {
  const today = new Date();
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
