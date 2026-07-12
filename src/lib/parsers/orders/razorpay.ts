// Razorpay payment-confirmation parser — the single highest-value order source.
//
// Most Indian D2C brands and services collect via Razorpay, which emails a
// "Payment successful for <MERCHANT>" confirmation for every charge. Verified
// against KP's real emails (2026-07-12):
//   Subject: "Payment successful for HOURGLASS DESIGN PVT LTD"
//   Body:    "HOURGLASS DESIGN PVT LTD ₹1499.00 Paid Successfully
//             Payment Id pay_TC9eNwlrjKi1dV Method card XXXX-XXXX-XXXX-4455
//             Paid On 11 Jul, 2026 03:29:39 PM IST …"
//
// Why this is the best matcher, better than the merchant's own order email:
//   • The merchant string is the REGISTERED ENTITY ("HOURGLASS DESIGN PVT
//     LTD") — which is exactly what the bank shows as its descriptor
//     ("hourglass"). So it earns name affinity where the brand email ("The
//     Postbox") does not. Same for "Raz*inmarwar", "Raz*nicobar", etc.
//   • Exact amount + a to-the-second timestamp.
//
// Guards:
//   • ONLY "Paid Successfully" / subscription-charged emails become orders.
//     "Payment failed" (a real Fleck example: failed then instantly retried)
//     and "Subscription Cancelled" must NOT create a phantom order.
//   • Refund emails → kind 'refund' (match against credit txns).

import { type ParsedOrder, parseInrAmount, decodeEntities } from "./types";

const SUCCESS_RE   = /paid\s+successfully|payment\s+of\s+₹|has\s+been\s+made/i;
const FAILED_RE    = /payment\s+failed|failed|cancelled|declined/i;
const REFUND_RE    = /refund/i;
// Merchant from the subject: "Payment successful for X" / "Subscription
// Initialized for X" / "Payment failed for X".
const SUBJECT_MERCHANT_RE =
  /(?:payment\s+(?:successful|failed)|subscription\s+\w+|payment\s+of\s+₹[\d,.]+)\s+(?:for|to)\s+(.+?)\s*$/i;
const AMOUNT_PAID_RE = /₹\s*([\d,]+(?:\.\d{1,2})?)\s*(?:paid\s+successfully|has\s+been\s+made)/i;
const AMOUNT_ANY_RE  = /₹\s*([\d,]+(?:\.\d{1,2})?)/;
const PAYMENT_ID_RE  = /Payment\s+Id\s+(pay_\w+)/i;
const SUBSCRIPTION_ID_RE = /Subscription\s+ID:?\s+(sub_\w+)/i;

export function parseRazorpayOrder(subject: string, text: string, _html: string): ParsedOrder | null {
  const hay = `${subject}\n${text}`;
  const isRefund = REFUND_RE.test(subject);

  // A failed/cancelled payment is not a spend — never store it. (Refund is a
  // real event and handled as kind:'refund'.)
  if (!isRefund && FAILED_RE.test(subject)) return null;
  if (!isRefund && !SUCCESS_RE.test(hay)) return null;

  // Amount — prefer the "₹X Paid Successfully" anchor, else the first ₹ value.
  const amount = AMOUNT_PAID_RE.exec(text) ?? AMOUNT_ANY_RE.exec(text);
  if (!amount) return null;

  // Merchant — from the subject ("… for HOURGLASS DESIGN PVT LTD"); fall back
  // to the first body line (Razorpay leads the body with the merchant name).
  const subjMerchant = SUBJECT_MERCHANT_RE.exec(subject.trim())?.[1];
  const bodyMerchant = /^\s*(.+?)\s+₹/.exec(text)?.[1];
  const merchant = decodeEntities(subjMerchant || bodyMerchant || "").trim() || undefined;

  return {
    source: "razorpay",
    kind: isRefund ? "refund" : "order",
    order_ref: PAYMENT_ID_RE.exec(text)?.[1] ?? SUBSCRIPTION_ID_RE.exec(text)?.[1],
    merchant_name: merchant,
    total_amount: parseInrAmount(amount[1]),
    items: [],
  };
}
