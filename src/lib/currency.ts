// Centralized currency detection.
//
// Single source of truth for "is this transaction in INR or some foreign
// currency?". Used by the generic sniffer, the txn-enrich helper, and any
// future parser that needs to tag a transaction with its true currency.
//
// Detection rules (in priority order):
//   1. Explicit ISO 4217 code in the text (USD, IDR, EUR, ...)  → that code
//   2. Currency symbol (₹, $, €, £, ¥, Rp, ...)                 → mapped code
//   3. "Rs." / "Rs " / "Rs.\d"                                   → INR
//   4. Bare amount with no currency cue                          → INR (default)
//
// The "default to INR" rule matches the user's intent: Indian banks send
// the overwhelming majority of their alerts without restating the currency,
// and we shouldn't mis-classify those as foreign just because the email is
// terse.
//
// Symbols are deliberately NOT matched as a single regex token because
// some symbols collide ($ for USD/SGD/AUD/HKD/CAD/...). Where a symbol is
// ambiguous, we only return it if there's no stronger ISO-code signal in
// the surrounding text.

export type CurrencyCode = string; // ISO 4217 (uppercase)

/**
 * Currencies we know how to convert to INR via the historical-FX cache.
 * Adding a code here doesn't enable detection — for that, also add it to
 * KNOWN_CODES below. This list exists so the FX helper can sanity-check.
 */
export const SUPPORTED_CURRENCIES: CurrencyCode[] = [
  "INR", "USD", "EUR", "GBP", "AED", "SGD", "AUD", "CAD", "JPY", "CHF",
  "IDR", "THB", "MYR", "HKD", "KRW", "VND", "NZD", "ZAR", "CNY", "PHP",
  "LKR", "NPR", "BDT", "MVR", "MMK", "KHR", "LAK", "TWD",
];

// Codes we'll match in a "look for [A-Z]{3}" sweep. Restricted to the
// supported set so random three-letter words ("THE", "AND") aren't flagged.
const KNOWN_CODES = new Set(SUPPORTED_CURRENCIES);

/**
 * Currency-symbol → ISO code map.
 * Only UNAMBIGUOUS symbols here. Ambiguous symbols ($, ¥) are handled
 * separately so we can prefer the explicit ISO code if both appear.
 */
const UNAMBIGUOUS_SYMBOLS: Array<[RegExp, CurrencyCode]> = [
  [/₹/,  "INR"],
  [/€/,  "EUR"],
  [/£/,  "GBP"],
  [/₩/,  "KRW"],
  [/₫/,  "VND"],
  [/฿/,  "THB"],
  [/Rp\b/, "IDR"],            // Indonesian Rupiah symbol
  [/RM\b/, "MYR"],            // Malaysian Ringgit symbol
];

/**
 * Ambiguous "$" / "¥" — only used if no explicit ISO code disambiguates.
 * Defaulting "$" to USD is the most common case globally; a user transacting
 * in S$/A$/HK$ will almost always have the bank include the explicit code
 * in the email anyway (e.g. "Transaction Amount: SGD 50.00").
 */
const AMBIGUOUS_DOLLAR = /\$/;
const AMBIGUOUS_YEN    = /¥/;

/**
 * Detect the currency of a transaction email body.
 *
 * @param text  Subject + body + snippet, concatenated.
 * @returns     ISO 4217 code. Defaults to "INR" if nothing matches.
 */
export function detectCurrency(text: string): CurrencyCode {
  if (!text) return "INR";

  // 1. Explicit ISO code with word boundaries. Pick the FIRST one that
  //    appears next to a digit — this avoids treating a stray "USD" in
  //    fine print (e.g. an FX disclosure footer) as the txn currency.
  const isoNearAmount = /\b([A-Z]{3})\s*[\.\s]?\s*[\d,]/g;
  let m: RegExpExecArray | null;
  while ((m = isoNearAmount.exec(text)) !== null) {
    const code = m[1].toUpperCase();
    if (KNOWN_CODES.has(code)) return code;
  }

  // 2. Unambiguous symbols. ₹ wins immediately → INR.
  for (const [re, code] of UNAMBIGUOUS_SYMBOLS) {
    if (re.test(text)) return code;
  }

  // 3. "Rs." / "Rs " / "Rs<digit>" → INR. Word boundary stops "Rsync" etc.
  if (/\bRs\.?\s*[\d₹]/i.test(text)) return "INR";

  // 4. Ambiguous dollar/yen — only as a last-resort signal.
  if (AMBIGUOUS_DOLLAR.test(text)) return "USD";
  if (AMBIGUOUS_YEN.test(text))    return "JPY";

  // 5. Default.
  return "INR";
}

/**
 * Pull (currency, amount) out of an amount-bearing string.
 * Used by the generic sniffer when it's already located the money line.
 *
 * Returns null only if no number is present at all.
 */
export function extractAmountAndCurrency(text: string): { currency: CurrencyCode; amount: number } | null {
  // Amount: any digit run with optional thousand separators + decimals.
  const amtMatch = /([\d,]+(?:\.\d{1,2})?)/.exec(text);
  if (!amtMatch) return null;
  const amount = parseFloat(amtMatch[1].replace(/,/g, ""));
  if (!isFinite(amount) || amount <= 0) return null;

  return { currency: detectCurrency(text), amount };
}

/**
 * True if the code is INR (or null/empty, treated as legacy INR rows).
 * Centralized so callers don't repeat the case-insensitive comparison.
 */
export function isInr(code: string | null | undefined): boolean {
  return !code || code.toUpperCase() === "INR";
}
