// HSBC India credit-card transaction email parser.
//
// Debit format:
//   Sender:  "hsbc@mail.hsbc.co.in"
//   Subject: "You have used your HSBC Credit Card ending with 3337 for a
//             purchase transaction"
//   Body:    "your Credit card no ending with 3337,has been used for INR
//             1029.60 for payment to ETERNAL LIMITED on 01 May 2026 at 21:22."
//
// Debit format since 2026-09 (real alerts from 4502, any currency):
//   Sender:  "hsbc@hsbc.bank.in"
//   Subject: "Credit Card Transaction Alert"
//   Body:    "your HSBC Credit Card xx4502 was used for a transaction of INR
//             2590.65 at MYGATE on 31/10/26. Available limit: INR 66297.00
//             Amount due: INR 33703.00"
//
// Refund/reversal (inferred — to be confirmed with real samples):
//   "INR X.XX has been credited/reversed/refunded to your Credit card no
//    ending with 3337 on DD Mon YYYY at HH:MM."

import type { ParsedTxn } from "./axis";
import { detectCurrency, isInr } from "../currency";

// Debit. Group 2 is the currency, as in the 2026-09 template below.
const TXN_RE =
  /ending\s+with\s+(\d{4})[\s,]+has\s+been\s+used\s+for\s+([A-Z]{3})\s+(\S+)\s+for\s+payment\s+to\s+(.+?)\s+on\s+(\d{1,2}\s+\w+\s+\d{4})\s+at\s+(\d{2}:\d{2})/i;

// 2026-09 debit. Group 2 is the currency: this template states it right next to
// the amount, so a USD hold needs no help from the generic sniffer.
const ALERT_2026_RE =
  /HSBC\s+Credit\s+Card\s+xx(\d{4})\s+was\s+used\s+for\s+a\s+transaction\s+of\s+([A-Z]{3})\s*(\S+)\s+at\s+(.+?)\s+on\s+(\d{1,2}\/\d{1,2}\/\d{2,4})(?=\.|\s|$)/i;

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

// "31/10/26" → Date, day first. Null on an impossible date such as 31/02/26,
// which `new Date()` would silently roll into March.
function parseDMY(s: string): Date | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = new Date(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T12:00:00+05:30`);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d : null;
}

export function parseHsbcTxn(subject: string, body: string, snippet: string = ""): ParsedTxn | null {
  const combined = `${body} ${snippet}`.replace(/\s+/g, " ").trim();

  // Both debit templates are checked before the guard below, which would hand a
  // USD alert to the generic sniffer. That sniffer needs a verb like "debited",
  // and neither template has one.
  const alert = ALERT_2026_RE.exec(combined);
  if (alert) {
    const currency = alert[2].toUpperCase();
    const amount = parseAmount(alert[3]);
    const txnAt = parseDMY(alert[5]);
    if (!Number.isFinite(amount) || !(amount > 0) || !VALID_AMOUNT_RE.test(alert[3]) || !txnAt) return null;
    return {
      card_last4: alert[1],
      amount_inr: isInr(currency) ? amount : 0,
      merchant_raw: alert[4].trim(),
      txn_at: txnAt,
      txn_type: "debit",
      ...(isInr(currency) ? {} : { currency, amount_original: amount }),
    };
  }

  const m = TXN_RE.exec(combined);
  if (m) {
    const currency = m[2].toUpperCase();
    const amount = parseAmount(m[3]);
    if (!Number.isFinite(amount) || !(amount > 0) || !VALID_AMOUNT_RE.test(m[3])) return null;
    return {
      card_last4: m[1],
      amount_inr: isInr(currency) ? amount : 0,
      merchant_raw: m[4].trim(),
      txn_at: parseDMonY(m[5]) ?? new Date(),
      txn_type: "debit",
      ...(isInr(currency) ? {} : { currency, amount_original: amount }),
    };
  }

  // Foreign-currency guard — see hdfc.ts for rationale.
  if (!isInr(detectCurrency(`${subject} ${combined}`))) return null;

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
