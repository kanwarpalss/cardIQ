// HDFC Bank credit-card transaction email parser.
//
// HDFC has shipped at least three subject/body variants over the years.
// This parser tries body patterns FIRST (they're the source of truth) and
// only falls back to subject-only when the body doesn't carry the data.
//
// Sender domains: hdfcbank.net, hdfcbank.com (legacy), hdfcbank.bank.in (2025+)
//
// Body variants we handle:
//
//   V3 (May 2026+, "InstaAlerts"):
//     Subject: "A payment was made using your Credit Card"
//     Body:    "Rs. 9939.79 has been debited from your HDFC Bank Credit Card
//               ending 5906 towards ASSPL on 08 May, 2026 at 08:27:30."
//
//   V2 (2024-2026):
//     Subject: "Rs.350.00 debited via Credit Card **5906"
//     Body:    "Rs.350.00 is debited from your HDFC Bank Credit Card ending
//               5906 towards RAZ*GoRally on 05 Feb, 2026 at 21:37:40."
//
//   V1 (legacy, pre-2024):
//     Subject: "Alert : Update on your HDFC Bank Credit Card"
//     Body:    "Thank you for using your HDFC Bank Credit Card ending 5906
//               for Rs 4022.40 at PAYPAL *STANSTEDEXP on 27-08-2023 17:10:44."
//
// Refunds:
//
//   V1 refund:
//     Body: "a refund for Rs 2115.95, from Bolt is credited to your HDFC
//            Bank Credit Card ending 5906 on 27-08-2023 21:54:29."
//
//   V2 reversal:
//     Subject: "Transaction reversal initiated"
//     Body:    "Transaction reversal of Rs.70.89 has been initiated to your
//               HDFC Bank Credit Card ending 5906. From Merchant:A Grab"

import type { ParsedTxn } from "./axis";
import { detectCurrency, isInr } from "../currency";

// ─── Regexes ─────────────────────────────────────────────────────────────────
// V2/V3 unified debit body. Allows:
//   • "Rs.350.00" OR "Rs. 9939.79"  (optional space after dot)
//   • "is debited" OR "has been debited"
const BODY_DEBIT_NEW_RE =
  /Rs\.?\s*([\d,]+(?:\.\d{1,2})?)\s+(?:is|has\s+been)\s+debited\s+from\s+your\s+HDFC\s+Bank\s+Credit\s+Card\s+ending\s+(\d{4})\s+towards\s+(.+?)\s+on\s+(\d{1,2}\s+\w+,?\s+\d{4})\s+at\s+(\d{2}:\d{2}:\d{2})/i;

// V1 legacy debit body
const BODY_DEBIT_LEGACY_RE =
  /for\s+Rs\.?\s+([\d,]+(?:\.\d{1,2})?)\s+at\s+(.+?)\s+on\s+(\d{2}-\d{2}-\d{4})\s+(\d{2}:\d{2}:\d{2})/i;

// V1 legacy refund body
const BODY_REFUND_LEGACY_RE =
  /refund\s+for\s+Rs\.?\s+([\d,]+(?:\.\d{1,2})?),?\s+from\s+(.+?)\s+is\s+credited\s+to\s+your\s+HDFC\s+Bank\s+Credit\s+Card\s+ending\s+(\d{4})\s+on\s+(\d{2}-\d{2}-\d{4})/i;

// V2 reversal body
const BODY_REVERSAL_RE =
  /Transaction\s+reversal\s+of\s+Rs\.?\s*([\d,]+(?:\.\d{1,2})?)\s+has\s+been\s+initiated\s+to\s+your\s+HDFC\s+Bank\s+Credit\s+Card\s+ending\s+(\d{4})(?:.*?From\s+Merchant[:\s]+(.+?))?(?:\.|$)/i;

// V2 subject — used for last4 fallback when the body regex fails.
const SUBJ_V2_DEBIT_RE = /Rs\.?\s*([\d,]+(?:\.\d{1,2})?)\s+debited\s+via\s+Credit\s+Card\s+\*+(\d{4})/i;

// "ending 5906" appears in V1 debit bodies (last4 isn't on a fixed position there).
const ENDING_LAST4_RE = /ending\s+(\d{4})/i;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function parseAmount(raw: string): number {
  return parseFloat(raw.replace(/,/g, ""));
}

// "27-08-2023" → Date (DD-MM-YYYY, India order)
function parseDMY(s: string): Date | null {
  const m = /(\d{2})-(\d{2})-(\d{4})/.exec(s);
  if (!m) return null;
  const d = new Date(`${m[3]}-${m[2]}-${m[1]}T12:00:00`);
  return isNaN(d.getTime()) ? null : d;
}

// "05 Feb, 2026" or "8 May 2026" → Date
function parseDMonY(s: string): Date | null {
  const d = new Date(s.replace(",", ""));
  return isNaN(d.getTime()) ? null : d;
}

// ─── Main ──────────────────────────────────────────────────────────────────────
export function parseHdfcTxn(subject: string, body: string, snippet: string = ""): ParsedTxn | null {
  const combined = `${body} ${snippet}`.replace(/\s+/g, " ").trim();
  const subj = subject.trim();

  // Foreign-currency guard. HDFC's regexes are hardcoded for "Rs." — a
  // foreign-currency txn (e.g. "USD 50.00 was charged...") would match
  // none of them, but we don't want it silently dropped either. Return
  // null here and let the generic sniffer handle it (which uses
  // lib/currency.ts and will tag it correctly).
  if (!isInr(detectCurrency(`${subj} ${combined}`))) return null;

  // ── 1. NEW debit (V2 + V3) — body is canonical, ignore subject wording ───
  const newDebit = BODY_DEBIT_NEW_RE.exec(combined);
  if (newDebit) {
    return {
      card_last4: newDebit[2],
      amount_inr: parseAmount(newDebit[1]),
      merchant_raw: newDebit[3].trim(),
      txn_at: parseDMonY(newDebit[4]) ?? new Date(),
      txn_type: "debit",
    };
  }

  // ── 2. LEGACY debit (V1) ─────────────────────────────────────────────────
  const oldDebit = BODY_DEBIT_LEGACY_RE.exec(combined);
  if (oldDebit) {
    const last4 = ENDING_LAST4_RE.exec(combined)?.[1] ?? "";
    return {
      card_last4: last4,
      amount_inr: parseAmount(oldDebit[1]),
      merchant_raw: oldDebit[2].trim(),
      txn_at: parseDMY(oldDebit[3]) ?? new Date(),
      txn_type: "debit",
    };
  }

  // ── 3. LEGACY refund ─────────────────────────────────────────────────────
  const oldRefund = BODY_REFUND_LEGACY_RE.exec(combined);
  if (oldRefund) {
    return {
      card_last4: oldRefund[3],
      amount_inr: parseAmount(oldRefund[1]),
      merchant_raw: oldRefund[2].trim(),
      txn_at: parseDMY(oldRefund[4]) ?? new Date(),
      txn_type: "credit",
    };
  }

  // ── 4. NEW reversal (V2) ─────────────────────────────────────────────────
  const reversal = BODY_REVERSAL_RE.exec(combined);
  if (reversal) {
    return {
      card_last4: reversal[2],
      amount_inr: parseAmount(reversal[1]),
      merchant_raw: reversal[3]?.trim(),
      txn_at: new Date(),
      txn_type: "credit",
    };
  }

  // ── 5. Last-resort: V2 subject-only (body unreadable but subject has it) ─
  // Only used when body parsing failed entirely. Keeps amount + last4 even
  // though merchant + date will be unreliable.
  const subjV2 = SUBJ_V2_DEBIT_RE.exec(subj);
  if (subjV2) {
    return {
      card_last4: subjV2[2],
      amount_inr: parseAmount(subjV2[1]),
      merchant_raw: undefined,
      txn_at: new Date(),
      txn_type: "debit",
    };
  }

  return null;
}
