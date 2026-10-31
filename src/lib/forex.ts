// Currency display helper. Rates live in src/lib/historical-fx.ts.

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
