// HDFC Bank credit-card transaction email parser.
//
// New format (debit):
//   Subject: "Rs.350.00 debited via Credit Card **5906"
//   Body:    "Rs.350.00 is debited from your HDFC Bank Credit Card ending 5906 towards RAZ*GoRally on 05 Feb, 2026 at 21:37:40."
//
// Old format (debit):
//   Subject: "Alert : Update on your HDFC Bank Credit Card"
//   Body:    "Thank you for using your HDFC Bank Credit Card ending 5906 for Rs 4022.40 at PAYPAL *STANSTEDEXP on 27-08-2023 17:10:44."
//
// Old format (credit/refund):
//   Body:    "a refund for Rs 2115.95, from Bolt is credited to your HDFC Bank Credit Card ending 5906 on 27-08-2023 21:54:29."
//
// New format (reversal):
//   Subject: "Transaction reversal initiated"
//   Body:    "Transaction reversal of Rs.70.89 has been initiated to your HDFC Bank Credit Card ending 5906. From Merchant:A Grab*"

import type { ParsedTxn } from "./axis";

// New debit: "Rs.350.00 debited via Credit Card **5906"
const SUBJ_NEW_DEBIT_RE = /Rs\.([\d,]+(?:\.\d{1,2})?)\s+debited\s+via\s+Credit\s+Card\s+\*+(\d{4})/i;

// Old debit body: "for Rs 4022.40 at MERCHANT on DATE"
const BODY_OLD_DEBIT_RE =
  /for\s+Rs\s+([\d,]+(?:\.\d{1,2})?)\s+at\s+(.+?)\s+on\s+(\d{2}-\d{2}-\d{4})\s+(\d{2}:\d{2}:\d{2})/i;

// New debit body: "Rs.350.00 is debited from ... ending 5906 towards MERCHANT on DD Mon, YYYY at HH:MM:SS"
const BODY_NEW_DEBIT_RE =
  /Rs\.([\d,]+(?:\.\d{1,2})?)\s+is\s+debited\s+from\s+your\s+HDFC\s+Bank\s+Credit\s+Card\s+ending\s+(\d{4})\s+towards\s+(.+?)\s+on\s+(\d{2}\s+\w+,?\s+\d{4})\s+at\s+(\d{2}:\d{2}:\d{2})/i;

// Old refund body: "a refund for Rs 2115.95, from MERCHANT is credited to your ... ending 5906 on DATE"
const BODY_OLD_CREDIT_RE =
  /refund\s+for\s+Rs\s+([\d,]+(?:\.\d{1,2})?),?\s+from\s+(.+?)\s+is\s+credited\s+to\s+your\s+HDFC\s+Bank\s+Credit\s+Card\s+ending\s+(\d{4})\s+on\s+(\d{2}-\d{2}-\d{4})/i;

// New reversal body: "Transaction reversal of Rs.70.89 has been initiated ... ending 5906. From Merchant:MERCHANT"
const BODY_REVERSAL_RE =
  /Transaction\s+reversal\s+of\s+Rs\.([\d,]+(?:\.\d{1,2})?)\s+has\s+been\s+initiated\s+to\s+your\s+HDFC\s+Bank\s+Credit\s+Card\s+ending\s+(\d{4})(?:.*?From\s+Merchant[:\s]+(.+?))?(?:\.|$)/i;

// Card last4 from subject "**5906"
const SUBJ_LAST4_RE = /\*\*(\d{4})/;

function parseAmount(raw: string): number {
  return parseFloat(raw.replace(/,/g, ""));
}

// Parse "27-08-2023" → Date
function parseDMY(s: string): Date | null {
  const m = /(\d{2})-(\d{2})-(\d{4})/.exec(s);
  if (!m) return null;
  const d = new Date(`${m[3]}-${m[2]}-${m[1]}T12:00:00`);
  return isNaN(d.getTime()) ? null : d;
}

// Parse "05 Feb, 2026" → Date
function parseDMonY(s: string): Date | null {
  const d = new Date(s.replace(",", ""));
  return isNaN(d.getTime()) ? null : d;
}

export function parseHdfcTxn(subject: string, body: string, snippet: string = ""): ParsedTxn | null {
  const combined = `${body} ${snippet}`.replace(/\s+/g, " ").trim();
  const subj = subject.trim();

  // --- New debit format ---
  const newDebitSubj = SUBJ_NEW_DEBIT_RE.exec(subj);
  if (newDebitSubj) {
    const m = BODY_NEW_DEBIT_RE.exec(combined);
    if (m) {
      return {
        card_last4: m[2],
        amount_inr: parseAmount(m[1]),
        merchant_raw: m[3].trim(),
        txn_at: parseDMonY(m[4]) ?? new Date(),
        txn_type: "debit",
      };
    }
    // Fallback: get last4 from subject, merchant from snippet
    const last4m = SUBJ_LAST4_RE.exec(subj);
    if (last4m) {
      const towardsM = /towards\s+(.+?)\s+on\s/i.exec(combined);
      return {
        card_last4: last4m[1],
        amount_inr: parseAmount(newDebitSubj[1]),
        merchant_raw: towardsM?.[1]?.trim(),
        txn_at: new Date(),
        txn_type: "debit",
      };
    }
  }

  // --- Old debit format ---
  const oldDebit = BODY_OLD_DEBIT_RE.exec(combined);
  if (oldDebit) {
    const last4m = /ending\s+(\d{4})/i.exec(combined);
    return {
      card_last4: last4m?.[1] ?? "",
      amount_inr: parseAmount(oldDebit[1]),
      merchant_raw: oldDebit[2].trim(),
      txn_at: parseDMY(oldDebit[3]) ?? new Date(),
      txn_type: "debit",
    };
  }

  // --- Old credit/refund ---
  const oldCredit = BODY_OLD_CREDIT_RE.exec(combined);
  if (oldCredit) {
    return {
      card_last4: oldCredit[3],
      amount_inr: parseAmount(oldCredit[1]),
      merchant_raw: oldCredit[2].trim(),
      txn_at: parseDMY(oldCredit[4]) ?? new Date(),
      txn_type: "credit",
    };
  }

  // --- New reversal ---
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

  return null;
}
