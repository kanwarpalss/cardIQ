// Generic transaction sniffer — runs as a fallback when no sender-specific
// parser matches. Designed to catch:
//
//   • New card alert formats from known banks (e.g. HDFC ships V4 next year)
//   • New banks/issuers the user has cards with but we haven't written a
//     dedicated parser for yet
//
// Strategy: look for the simultaneous presence of
//   (a) a transactional verb  (debited/credited/spent/charged/refunded/...)
//   (b) a currency amount     (Rs. 123 / INR 123 / USD 123 / etc.)
//   (c) a card-last4 reference that matches one of the user's known cards
//
// All three must be present. Marketing emails will fail at least one.
// Returns the same ParsedTxn shape as bank-specific parsers, plus a
// `low_confidence: true` flag so the caller can decide how to treat it.

import type { ParsedTxn } from "./axis";

export type GenericParsed = ParsedTxn & { low_confidence: true };

// ─── Regexes ─────────────────────────────────────────────────────────────────
// Currency-prefixed amount: "Rs. 123.45", "Rs.123", "INR 1,234.56", "USD 50",
// "EUR 99.99", "GBP 10", "AED 500". Captures (currency, amount).
const AMOUNT_RE =
  /\b(Rs\.?|INR|USD|EUR|GBP|AED|SGD|AUD|CAD|JPY|CHF)\s*([\d,]+(?:\.\d{1,2})?)\b/i;

// Card last4 reference: matches XX1234, **1234, ending 1234, ending with 1234,
// "card no. 1234". Captures the 4 digits.
const LAST4_RE =
  /(?:XX|\*\*|ending\s+(?:with\s+)?|card\s+(?:no\.?|number)?\s*:?\s*X?X?)\s*(\d{4})\b/i;

// Transactional verbs — at least one must appear.
const TXN_VERB_RE =
  /\b(debited|credited|spent|charged|refunded|reversed|withdrawn|paid|purchased|payment\s+(?:was|of))\b/i;

// Strong "this is NOT a transaction" signals — used to bail out early to
// avoid false positives on marketing/promotional emails.
const MARKETING_SIGNALS_RE =
  /\b(unsubscribe|offer\s+expires|valid\s+(?:till|until)|terms\s+(?:and|&)\s+conditions\s+apply|\d+%\s+(?:off|cashback|discount)|sale\s+ends|book\s+now|click\s+here|special\s+offer)\b/i;

// Strong refund/credit signals — if matched, we mark txn_type=credit.
const CREDIT_SIGNALS_RE = /\b(refund|reversed|credited|reversal|cashback)\b/i;

// Merchant extraction patterns — try in order, take first match.
// Each pattern's group 1 is the merchant name.
const MERCHANT_PATTERNS = [
  /towards\s+([^.]+?)\s+on\s+\d/i,                              // HDFC-ish
  /payment\s+to\s+([^.]+?)\s+on\s+\d/i,                          // HSBC-ish
  /at\s+([^.]+?)\s+on\s+\d{2}-\d{2}-\d{4}/i,                     // legacy
  /Info[:\s]+([^.]+?)(?:\.|The\s+Available|$)/i,                 // ICICI-ish
  /Merchant\s+(?:Name|Details)[:\s]+([^\n\r]+?)(?=\s{2,}|$)/i,   // structured
  /(?:from|to)\s+merchant[:\s]+([^.]+?)(?:\.|$)/i,               // reversal-ish
];

function parseAmountStr(raw: string): number {
  return parseFloat(raw.replace(/,/g, ""));
}

function extractMerchant(text: string): string | undefined {
  for (const re of MERCHANT_PATTERNS) {
    const m = re.exec(text);
    if (m?.[1]) {
      const cleaned = m[1].trim().replace(/[.,;]+$/, "");
      if (cleaned.length >= 2 && cleaned.length <= 80) return cleaned;
    }
  }
  return undefined;
}

/**
 * Generic transaction sniffer.
 *
 * @param subject       email subject
 * @param body          email body (plain text or HTML-stripped)
 * @param snippet       Gmail snippet
 * @param knownLast4s   Set of card last4s the user has registered. The
 *                      sniffer ONLY returns a hit if the email mentions one
 *                      of these — this is what kills marketing false positives
 *                      that happen to look transactional.
 */
export function genericSniff(
  subject: string,
  body: string,
  snippet: string,
  knownLast4s: Set<string>,
): GenericParsed | null {
  const combined = `${subject} ${body} ${snippet}`.replace(/\s+/g, " ").trim();

  // 1. Marketing veto — if it shouts "unsubscribe / 50% off / offer expires",
  //    bail. Some banks include "T&C apply" in real alerts, so we require
  //    at least 2 marketing signals to veto.
  let marketingHits = 0;
  let m: RegExpExecArray | null;
  const marketingRe = new RegExp(MARKETING_SIGNALS_RE.source, "gi");
  while ((m = marketingRe.exec(combined)) !== null) {
    marketingHits++;
    if (marketingHits >= 2) return null;
  }

  // 2. Must contain a transactional verb.
  if (!TXN_VERB_RE.test(combined)) return null;

  // 3. Must contain a card last4 that the user actually has.
  const last4Match = LAST4_RE.exec(combined);
  if (!last4Match) return null;
  const last4 = last4Match[1];
  if (knownLast4s.size > 0 && !knownLast4s.has(last4)) {
    // Mentions a last4 but not one of the user's cards. Could be a
    // statement summary or a different account — don't treat as a txn.
    return null;
  }

  // 4. Must contain a currency amount.
  const amtMatch = AMOUNT_RE.exec(combined);
  if (!amtMatch) return null;
  const currencyRaw = amtMatch[1].toUpperCase();
  const currency = currencyRaw === "RS" || currencyRaw === "RS." ? "INR" : currencyRaw;
  const amount = parseAmountStr(amtMatch[2]);

  // 5. Decide debit vs credit from the surrounding text.
  const txn_type: "debit" | "credit" = CREDIT_SIGNALS_RE.test(combined) ? "credit" : "debit";

  return {
    card_last4: last4,
    amount_inr: currency === "INR" ? amount : amount,  // caller can convert
    merchant_raw: extractMerchant(combined),
    txn_at: new Date(),                                 // caller should overwrite with email date
    txn_type,
    ...(currency !== "INR" ? { currency, amount_original: amount } : {}),
    low_confidence: true,
  };
}
