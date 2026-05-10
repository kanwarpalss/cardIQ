// Forex conversion helper.
//
// Pragmatic v1: a hardcoded INR-rate table for the currencies our users
// most commonly transact in. Updated periodically (see RATES_AS_OF below).
//
// Why hardcoded instead of a live API call?
//   • Zero network latency on dashboard renders.
//   • No API key, no rate limits, no provider lock-in.
//   • Approximate is fine — this is for "roughly how much was that USD/IDR
//     transaction in INR?", not for accounting/booking.
//
// Future upgrade path: swap the static map for a daily-fetched rate cached
// in the user_settings table (or a tiny dedicated table). The convert()
// signature won't need to change.

/** Last manual refresh of the rate table. Bump when you update RATES. */
export const RATES_AS_OF = "2026-05-01";

/** 1 unit of foreign currency = N INR (approximate, mid-market). */
const RATES: Record<string, number> = {
  INR: 1,
  USD: 84.5,
  EUR: 91.2,
  GBP: 106.8,
  AED: 23.0,
  SGD: 62.5,
  AUD: 56.3,
  CAD: 61.0,
  JPY: 0.55,
  CHF: 95.0,
  IDR: 0.0053,   // 1 IDR ≈ 0.005 INR (10,000 IDR ≈ ₹53)
  THB: 2.45,
  MYR: 17.8,
  HKD: 10.85,
};

/**
 * Convert `amount` of `currency` to INR using the static table. Returns
 * `null` for unknown currencies so the caller can decide how to display
 * (e.g. "—" instead of misleading 0).
 */
export function toInr(amount: number, currency: string | null | undefined): number | null {
  if (!currency) return amount; // assume INR if unspecified
  const code = currency.toUpperCase();
  const rate = RATES[code];
  if (rate === undefined) return null;
  return amount * rate;
}

/** Number of distinct currencies we know about (excluding INR itself). */
export const SUPPORTED_FOREIGN_CURRENCIES = Object.keys(RATES).filter((c) => c !== "INR");

/**
 * Format an amount in its native currency.
 * Examples:
 *   format(12272062, "IDR") → "IDR 12,272,062"
 *   format(50.5,    "USD") → "USD 50.50"
 *   format(1234,    null)  → "₹1,234"
 */
export function formatCurrency(amount: number, currency: string | null | undefined): string {
  const code = (currency ?? "INR").toUpperCase();
  if (code === "INR") {
    return "₹" + amount.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  }
  // For most foreign currencies we show 2 decimals; for IDR/JPY/THB which
  // typically have larger nominal amounts we drop the decimals.
  const noDecimals = ["IDR", "JPY", "VND", "KRW"].includes(code);
  return `${code} ${amount.toLocaleString("en-US", {
    minimumFractionDigits: noDecimals ? 0 : 2,
    maximumFractionDigits: noDecimals ? 0 : 2,
  })}`;
}
