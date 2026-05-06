// HSBC India credit-card transaction email parser.
//
// Format:
//   Sender:  "hsbc@mail.hsbc.co.in"
//   Subject: "You have used your HSBC Credit Card ending with 3337 for a purchase transaction"
//   Body/snippet: "your Credit card no ending with 3337,has been used for INR 1029.60
//                  for payment to ETERNAL LIMITED on 01 May 2026 at 21:22."

import type { ParsedTxn } from "./axis";

// "ending with 3337,has been used for INR 1029.60 for payment to MERCHANT on DD Mon YYYY at HH:MM"
const TXN_RE =
  /ending\s+with\s+(\d{4})[\s,]+has\s+been\s+used\s+for\s+INR\s+([\d,]+(?:\.\d{1,2})?)\s+for\s+payment\s+to\s+(.+?)\s+on\s+(\d{2}\s+\w+\s+\d{4})\s+at\s+(\d{2}:\d{2})/i;

function parseAmount(raw: string): number {
  return parseFloat(raw.replace(/,/g, ""));
}

// "01 May 2026" → Date
function parseDMonY(s: string): Date | null {
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export function parseHsbcTxn(subject: string, body: string, snippet: string = ""): ParsedTxn | null {
  const combined = `${body} ${snippet}`.replace(/\s+/g, " ").trim();

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

  return null;
}
