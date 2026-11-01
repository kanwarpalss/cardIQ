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

const NEW_DOMAIN_TXN_RE = /HSBC\s+Credit\s+Card\s+xx(\d{4})\s+was\s+used\s+for\s+a\s+transaction\s+of\s+([A-Z]{3})\s*(\S+)\s+at\s+(.+?)\s+on\s+(\d{2})\/(\d{2})\/(\d{2})(?:\.|\s|$)/i;
const VALID_AMOUNT_RE = /^(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d{1,2})?$/;

// A damaged purchase field must never be reinterpreted as the available
// balance by the generic fallback (e.g. when a footer says "payment of").
export function isHsbcPurchaseAlert(body: string, snippet = ""): boolean {
  return /HSBC\s+Credit\s+Card\s+xx\d{4}\s+was\s+used\s+for\s+a\s+transaction\s+of\b/i.test(`${body} ${snippet}`);
}

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

  // The amount's own currency is authoritative: real USD Facebook alerts
  // also contain INR balances. enrichAmount handles conversion downstream.
  const recent = NEW_DOMAIN_TXN_RE.exec(combined);
  if (recent) {
    const currency = recent[2].toUpperCase();
    const amount = Number(recent[3].replace(/,/g, ""));
    const at = new Date(`20${recent[7]}-${recent[6]}-${recent[5]}T12:00:00+05:30`);
    if (!VALID_AMOUNT_RE.test(recent[3]) || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(at.getTime()) || at.getUTCDate() !== Number(recent[5]) || at.getUTCMonth() + 1 !== Number(recent[6])) return null;
    return { card_last4: recent[1], amount_inr: currency === "INR" ? amount : 0,
      ...(currency === "INR" ? {} : { currency, amount_original: amount }),
      merchant_raw: recent[4].trim(), txn_at: at, txn_type: "debit" };
  }

  // Older layouts remain INR-only; never take a foreign alert's INR limit.
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
