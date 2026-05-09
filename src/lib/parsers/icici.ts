// ICICI Bank credit-card transaction email parser.
//
// Debit format:
//   Subject: "Transaction alert for your ICICI Bank Credit Card"
//   Body:    "Your ICICI Bank Credit Card XX9004 has been used for a
//             transaction of INR 6000.00 on Apr 06, 2026 at 10:35:11.
//             Info: REWARD 360 GLOBAL SERV."
//
// Credit/reversal format (assumed — limited samples):
//   "INR X.XX has been reversed/refunded to your ICICI Bank Credit Card XX9004
//    on Apr 06, 2026 at 10:35:11."

import type { ParsedTxn } from "./axis";

// "Credit Card XX9004 has been used for a transaction of INR 6000.00 on Apr 06, 2026 at 10:35:11. Info: MERCHANT"
const TXN_RE =
  /Credit\s+Card\s+XX(\d{4})\s+has\s+been\s+used\s+for\s+a\s+transaction\s+of\s+INR\s+([\d,]+(?:\.\d{1,2})?)\s+on\s+(\w+\s+\d{1,2},\s+\d{4})\s+at\s+(\d{2}:\d{2}:\d{2})(?:.*?Info:\s*(.+?))?(?:\.\s|The Available|$)/i;

// Credit/reversal: capture amount, last4, AND date — previous version dropped
// the date and silently used `new Date()` (today's wall clock), which corrupted
// the time series for refunds.
const CREDIT_RE =
  /INR\s+([\d,]+(?:\.\d{1,2})?)\s+(?:has\s+been\s+)?(?:reversed|refunded|credited)(?:.*?Credit\s+Card\s+XX(\d{4}))(?:.*?on\s+(\w+\s+\d{1,2},\s+\d{4}))?/i;

function parseAmount(raw: string): number {
  return parseFloat(raw.replace(/,/g, ""));
}

// "Apr 06, 2026" or "Apr 6, 2026" → Date.
// We avoid `new Date(s)` which is implementation-defined; explicit YYYY-MM-DD
// build from a 12-month lookup is portable across runtimes.
const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};
function parseMonDY(s: string): Date | null {
  const m = /^(\w{3})\w*\s+(\d{1,2}),\s+(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const mm = MONTHS[m[1].toLowerCase()];
  if (!mm) return null;
  const dd = m[2].padStart(2, "0");
  const d = new Date(`${m[3]}-${mm}-${dd}T12:00:00`);
  return isNaN(d.getTime()) ? null : d;
}

export function parseIciciTxn(subject: string, body: string, snippet: string = ""): ParsedTxn | null {
  const combined = `${body} ${snippet}`.replace(/\s+/g, " ").trim();

  const m = TXN_RE.exec(combined);
  if (m) {
    return {
      card_last4: m[1],
      amount_inr: parseAmount(m[2]),
      // Strip trailing punctuation — the regex's terminator is greedy enough
      // to include a final period when there's no space after it.
      merchant_raw: m[5]?.trim().replace(/[.,;]+$/, "") || undefined,
      txn_at: parseMonDY(m[3]) ?? new Date(),
      txn_type: "debit",
    };
  }

  const c = CREDIT_RE.exec(combined);
  if (c) {
    return {
      card_last4: c[2],
      amount_inr: parseAmount(c[1]),
      merchant_raw: undefined,
      // c[3] is optional — fall back to caller-provided txn_at via sync route's
      // dateHeader override, but at minimum we now CAN capture it when present.
      txn_at: c[3] ? (parseMonDY(c[3]) ?? new Date()) : new Date(),
      txn_type: "credit",
    };
  }

  return null;
}
