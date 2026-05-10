// HSBC India credit-card transaction email parser.
//
// Debit format:
//   Sender:  "hsbc@mail.hsbc.co.in"
//   Subject: "You have used your HSBC Credit Card ending with 3337 for a
//             purchase transaction"
//   Body:    "your Credit card no ending with 3337,has been used for INR
//             1029.60 for payment to ETERNAL LIMITED on 01 May 2026 at 21:22."
//
// Refund/reversal (inferred — to be confirmed with real samples):
//   "INR X.XX has been credited/reversed/refunded to your Credit card no
//    ending with 3337 on DD Mon YYYY at HH:MM."

import type { ParsedTxn } from "./axis";
import { detectCurrency, isInr } from "../currency";

// Debit
const TXN_RE =
  /ending\s+with\s+(\d{4})[\s,]+has\s+been\s+used\s+for\s+INR\s+([\d,]+(?:\.\d{1,2})?)\s+for\s+payment\s+to\s+(.+?)\s+on\s+(\d{1,2}\s+\w+\s+\d{4})\s+at\s+(\d{2}:\d{2})/i;

// Credit/refund/reversal — also captures last4 + date.
const CREDIT_RE =
  /INR\s+([\d,]+(?:\.\d{1,2})?)\s+(?:has\s+been\s+)?(?:credited|reversed|refunded)(?:.*?ending\s+with\s+(\d{4}))(?:.*?on\s+(\d{1,2}\s+\w+\s+\d{4}))?/i;

function parseAmount(raw: string): number {
  return parseFloat(raw.replace(/,/g, ""));
}

// "01 May 2026" → Date. Portable lookup, not relying on `new Date(s)` quirks.
const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};
function parseDMonY(s: string): Date | null {
  const m = /^(\d{1,2})\s+(\w{3})\w*\s+(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase()];
  if (!mm) return null;
  const dd = m[1].padStart(2, "0");
  const d = new Date(`${m[3]}-${mm}-${dd}T12:00:00`);
  return isNaN(d.getTime()) ? null : d;
}

export function parseHsbcTxn(subject: string, body: string, snippet: string = ""): ParsedTxn | null {
  const combined = `${body} ${snippet}`.replace(/\s+/g, " ").trim();

  // Foreign-currency guard — see hdfc.ts for rationale.
  if (!isInr(detectCurrency(`${subject} ${combined}`))) return null;

  const m = TXN_RE.exec(combined);
  if (m) {
    return {
      card_last4: m[1],
      amount_inr: parseAmount(m[2]),
      merchant_raw: m[3].trim(),
      txn_at: parseDMonY(m[4]) ?? new Date(),
      txn_type: "debit",
    };
  }

  const c = CREDIT_RE.exec(combined);
  if (c) {
    return {
      card_last4: c[2],
      amount_inr: parseAmount(c[1]),
      merchant_raw: undefined,
      txn_at: c[3] ? (parseDMonY(c[3]) ?? new Date()) : new Date(),
      txn_type: "credit",
    };
  }

  return null;
}
