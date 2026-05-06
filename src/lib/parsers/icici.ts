// ICICI Bank credit-card transaction email parser.
//
// Format:
//   Subject: "Transaction alert for your ICICI Bank Credit Card"
//   Body/snippet: "Your ICICI Bank Credit Card XX9004 has been used for a transaction of INR 6000.00
//                  on Apr 06, 2026 at 10:35:11. Info: REWARD 360 GLOBAL SERV."

import type { ParsedTxn } from "./axis";

// "Credit Card XX9004 has been used for a transaction of INR 6000.00 on Apr 06, 2026 at 10:35:11. Info: MERCHANT"
const TXN_RE =
  /Credit\s+Card\s+XX(\d{4})\s+has\s+been\s+used\s+for\s+a\s+transaction\s+of\s+INR\s+([\d,]+(?:\.\d{1,2})?)\s+on\s+(\w+\s+\d{2},\s+\d{4})\s+at\s+(\d{2}:\d{2}:\d{2})(?:.*?Info:\s*(.+?))?(?:\.|The Available|$)/i;

// Credit/reversal: "INR X.XX has been reversed/refunded ... Credit Card XX9004"
const CREDIT_RE =
  /INR\s+([\d,]+(?:\.\d{1,2})?)\s+(?:has\s+been\s+)?(?:reversed|refunded|credited).*?Credit\s+Card\s+XX(\d{4})/i;

function parseAmount(raw: string): number {
  return parseFloat(raw.replace(/,/g, ""));
}

// Parse "Apr 06, 2026" → Date
function parseMonDY(s: string): Date | null {
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export function parseIciciTxn(subject: string, body: string, snippet: string = ""): ParsedTxn | null {
  const combined = `${body} ${snippet}`.replace(/\s+/g, " ").trim();

  const m = TXN_RE.exec(combined);
  if (m) {
    return {
      card_last4: m[1],
      amount_inr: parseAmount(m[2]),
      merchant_raw: m[5]?.trim() || undefined,
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
      txn_at: new Date(),
      txn_type: "credit",
    };
  }

  return null;
}
