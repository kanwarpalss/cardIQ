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
// Amazon's official Order History CSV is now the source of truth for purchases.
// Refund emails remain useful evidence; every other Amazon email is ignored.

import { type ParsedOrder } from "./types";

// Amount and order ref are matched SEPARATELY: a short/odd order number must
// never take the refund amount down with it (boundary-prover finding).
const REFUND_AMOUNT_RE = /refund\s+for\s+₹\s*([\d,]+(?:\.\d{1,2})?)\s+has\s+been\s+processed/i;
const REFUND_REF_RE    = /Order\s*#?\s*(\d[\d-]{5,})/i;

export function parseAmazonOrder(_subject: string, text: string, _html: string): ParsedOrder | null {
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

  return null;
}
