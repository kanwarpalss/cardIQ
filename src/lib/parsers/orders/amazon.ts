// Amazon India email parser — deliberately narrow.
//
// Verified against KP's Gmail (2026-07-11): Amazon India NO LONGER sends
// order-confirmation emails with amounts. What exists:
//   • order-update@amazon.in     — "Delivered: “Emwel Dog Food Mat,...”"
//     (item name in the subject, truncated; NO amount anywhere)
//   • payments-messages@amazon.in — "Refund on order 404-8063799-7205955"
//     body: "…your refund for ₹69.42 has been processed for your Order
//     # 404-8063799-7205955…"
//
// So the honest capability is:
//   • Refund emails → amount + order ref → matched against CREDIT txns
//     with normal confidence rules.
//   • Delivered emails → item name only → can only ever be a LOW-confidence
//     match (no amount), and only when exactly one Amazon debit txn sits in
//     a tight date window. Wrong-match risk is why the matcher is strict.
//   • Everything else from amazon.in (shipped/arriving/reviews/returns) → null.

import { type ParsedOrder, decodeEntities } from "./types";

// "Delivered: “Emwel Dog Food Mat,...”" — smart or straight quotes; the
// subject truncates long names with … or "..." which we trim off.
const DELIVERED_SUBJECT_RE = /^Delivered:\s*[“"']?(.+?)[.…]*[”"']?\s*$/;
// Amount and order ref are matched SEPARATELY: a short/odd order number must
// never take the refund amount down with it (boundary-prover finding).
const REFUND_AMOUNT_RE = /refund\s+for\s+₹\s*([\d,]+(?:\.\d{1,2})?)\s+has\s+been\s+processed/i;
const REFUND_REF_RE    = /Order\s*#?\s*(\d[\d-]{5,})/i;
const ORDER_NUM_RE     = /\b(\d{3}-\d{7}-\d{7})\b/;

export function parseAmazonOrder(subject: string, text: string, _html: string): ParsedOrder | null {
  const refundAmount = REFUND_AMOUNT_RE.exec(text);
  if (refundAmount) {
    return {
      source: "amazon",
      kind: "refund",
      order_ref: REFUND_REF_RE.exec(text)?.[1],
      total_amount: parseFloat(refundAmount[1].replace(/,/g, "")),
      items: [],
    };
  }

  const delivered = DELIVERED_SUBJECT_RE.exec(subject.trim());
  if (delivered) {
    // Strip ALL trailing punctuation (truncation dots included) — an
    // all-ellipsis subject must yield null, not a garbage "." item.
    const name = decodeEntities(delivered[1]).replace(/[.…,\s]+$/, "").trim();
    if (!name) return null;
    return {
      source: "amazon",
      kind: "order",
      order_ref: ORDER_NUM_RE.exec(text)?.[1],
      merchant_name: undefined,
      // No amount in Amazon Delivered emails — matcher handles undefined
      // by requiring a unique candidate and capping confidence at 'low'.
      items: [{ name }],
    };
  }

  return null;
}
