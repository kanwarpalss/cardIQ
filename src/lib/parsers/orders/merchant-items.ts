// Merchant item overrides — for merchants whose emails carry NO line items but
// whose purchase is always the same known thing. KP-curated.
//
// Why this exists: some merchants bill through a payment rail (GoRally charges
// via Razorpay → "Payment successful for GoRally ₹350", zero items) yet the
// purchase is unambiguous. Rather than leave the order blank, we stamp the known
// item so the ledger reads what it actually was.
//
// Applied POST-parse in the registry, for ANY source, and ONLY when the parser
// found no real items — a genuine parsed item list always wins.

import type { OrderItem, ParsedOrder } from "./types";

const OVERRIDES: Array<{ match: RegExp; items: OrderItem[] }> = [
  // Pickleball court-booking services (all bill via Razorpay, no line items).
  { match: /\bgorally\b/i, items: [{ name: "Pickleball Game" }] },
  { match: /\bhudle\b/i, items: [{ name: "Pickleball Game" }] },
  { match: /\bhsquare\b/i, items: [{ name: "Pickleball Game" }] },
];

/**
 * Stamp a known item onto an order whose merchant matches an override and which
 * has no parsed items. `hint` should include the merchant name + subject +
 * sender so the match works regardless of which field carries the brand.
 */
export function applyMerchantItemOverride(order: ParsedOrder, hint: string): ParsedOrder {
  if (order.items.length > 0) return order;
  const hit = OVERRIDES.find((o) => o.match.test(hint));
  return hit ? { ...order, items: hit.items.map((i) => ({ ...i })) } : order;
}
