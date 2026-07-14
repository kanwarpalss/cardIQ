// Order → transaction matching (V2 feature C). Pure logic, no I/O —
// unit-tested in order-match.test.ts, called by /api/gmail/orders/sync.
//
// Philosophy: a WRONG match shown confidently is worse than no match
// (same principle as the manual-first rewards decision, SPEC §5 2026-07-08).
// Every rule below errs toward "no match" or "low confidence":
//
//   • Amount must match to within ₹0.75 (covers bank rounding of paise).
//   • Date window is ±5 days (order email lands around delivery; the card
//     charge happens at order time — Swiggy/Zomato same-day, BigBasket
//     slot-delivery up to a few days apart).
//   • 'order' emails match DEBIT txns; 'refund' emails match CREDIT txns.
//   • Merchant affinity (bank descriptor matches a source keyword like
//     "swiggy", OR shares a brand token with the order — "Raz*inmarwar" ↔ the
//     Inmarwar order email) is what buys HIGH/MEDIUM confidence.
//   • Without affinity we match on amount + time alone, but only when the
//     exact-amount candidate is UNIQUE in the window — then it's 'low'
//     ("? possible match"). Two+ candidates with no name signal → refuse.
//     (This is how D2C brands whose bank descriptor doesn't match the brand
//     name — e.g. Postbox billing as "hourglass" — still link up.)
//   • Amount-less orders (Amazon "Delivered:") need affinity AND a UNIQUE
//     candidate in a tight ±4-day window, and are always 'low'.
//
// Confidence semantics (rendered in the UI):
//   high   = exact amount + unique candidate, AND (affinity + ≤2 days)
//            OR (no affinity but ≤5 min apart — same-purchase proximity)  → "✓"
//   medium = exact amount + unique candidate + ≤5 days (weaker signal)     → "≈"
//   low    = matched, but ambiguous / no affinity + loose timing / no amt  → "?"

import type { OrderSource } from "./parsers/orders/types";

export type TxnLite = {
  id: string;
  amount_inr: number;
  txn_at: string;
  merchant: string | null;
  txn_type: "debit" | "credit";
};

export type OrderLite = {
  source: OrderSource;
  kind: "order" | "refund";
  total_amount: number | null;
  order_at: string;
  /** Brand/store name (marketplace restaurant, or D2C brand from the sender). */
  merchant_name?: string | null;
};

export type MatchConfidence = "high" | "medium" | "low";
export type OrderMatch = { txnId: string; confidence: MatchConfidence };

// The review state machine (migration 014). Only 'unmatched' orders are
// (re-)matched; 'rejected' is a permanent dead-end (reject = permanent unlink).
export type ReviewStatus = "unmatched" | "pending" | "confirmed" | "rejected";

/**
 * Review status a freshly-proposed match starts in:
 *   high  → 'confirmed' (auto — exact amount + brand affinity + same day, the
 *           129/197 obvious cases KP shouldn't have to rubber-stamp)
 *   med/low → 'pending' (waits in the Review queue for a thumbs-up)
 * This is the single home of the auto-confirm policy — UI and sync both defer
 * to it (ARCH-04: one source of truth).
 */
export function reviewStatusFor(confidence: MatchConfidence): "confirmed" | "pending" {
  return confidence === "high" ? "confirmed" : "pending";
}

const AMOUNT_TOLERANCE = 0.75;
const DAY_MS = 86_400_000;
const WINDOW_DAYS_WITH_AMOUNT = 5;
const WINDOW_DAYS_NO_AMOUNT = 4;
// "Same-purchase" proximity — an order email and its card charge fire within
// minutes of each other. A unique exact-amount hit inside this window is one
// event, so we auto-confirm it even without a brand-name match (mirrors the
// same-amount-within-5-min rule the duplicate detector already trusts).
const WINDOW_TIGHT_DAYS = 5 / (24 * 60); // 5 minutes

// Strings that mark a txn merchant as "belonging to" a marketplace source.
// Checked against the CURRENT merchant display name (which the user may have
// renamed), so parent-company names are included where banks use them.
// D2C sources (shopify/generic) have no fixed hint — their affinity comes from
// the brand name in the order email overlapping the bank descriptor.
const SOURCE_HINTS: Partial<Record<OrderSource, string[]>> = {
  swiggy:    ["swiggy", "bundl"],
  zomato:    ["zomato", "eternal"],
  bigbasket: ["bigbasket", "big basket", "bbnow", "bb now", "innovative retail"],
  amazon:    ["amazon", "amzn"],
  blinkit:   ["blinkit", "grofers"],
};

// Noise tokens that must never, on their own, count as a brand-name match
// between an order and a transaction (payment-gateway prefixes, generic words).
const AFFINITY_STOPWORDS = new Set([
  "raz", "razorpay", "pay", "payu", "ccav", "ccavenue", "bill", "the", "and",
  "ltd", "pvt", "llp", "inc", "india", "online", "store", "shop", "order", "www", "com",
]);

function daysApart(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / DAY_MS;
}

/** Significant lowercase tokens (len ≥ 4, non-stopword) of a merchant string. */
function brandTokens(name: string | null | undefined): string[] {
  if (!name) return [];
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !AFFINITY_STOPWORDS.has(t));
}

/**
 * Does this transaction "belong to" the order's merchant?
 *   • marketplace sources → the bank descriptor contains a known source hint;
 *   • any source → the order's brand name shares a significant token with the
 *     txn merchant. This is what links "Raz*inmarwar" (bank) to the Inmarwar
 *     order email, and is intentionally absent for Postbox (bank shows an
 *     unrelated "hourglass" descriptor → matched on amount+time alone).
 */
function hasAffinity(order: OrderLite, txn: TxnLite): boolean {
  const merchant = (txn.merchant ?? "").toLowerCase();
  if (!merchant) return false;

  const hints = SOURCE_HINTS[order.source] ?? [];
  if (hints.some((hint) => merchant.includes(hint))) return true;

  const merchantTokens = new Set(brandTokens(merchant));
  return brandTokens(order.merchant_name).some((t) => merchantTokens.has(t));
}

/**
 * Find the transaction this order belongs to, or null.
 *
 * @param usedTxnIds txns already claimed by another order in this run —
 *                   one transaction never gets two orders.
 */
export function matchOrderToTxn(
  order: OrderLite,
  txns: TxnLite[],
  usedTxnIds: ReadonlySet<string> = new Set()
): OrderMatch | null {
  const wantType = order.kind === "refund" ? "credit" : "debit";

  // ── Amount-less orders (Amazon Delivered): unique-affinity-only, low. ──
  if (order.total_amount == null) {
    const candidates = txns.filter(
      (t) =>
        t.txn_type === wantType &&
        !usedTxnIds.has(t.id) &&
        hasAffinity(order, t) &&
        daysApart(order.order_at, t.txn_at) <= WINDOW_DAYS_NO_AMOUNT
    );
    if (candidates.length !== 1) return null; // ambiguity → refuse to guess
    return { txnId: candidates[0].id, confidence: "low" };
  }

  // ── Amount-bearing orders. ──
  const sameAmount = txns.filter(
    (t) =>
      t.txn_type === wantType &&
      !usedTxnIds.has(t.id) &&
      Math.abs(t.amount_inr - order.total_amount!) <= AMOUNT_TOLERANCE &&
      daysApart(order.order_at, t.txn_at) <= WINDOW_DAYS_WITH_AMOUNT
  );
  if (sameAmount.length === 0) return null;

  const affine = sameAmount.filter((t) => hasAffinity(order, t));

  if (affine.length > 0) {
    const nearest = affine.reduce((best, t) =>
      daysApart(order.order_at, t.txn_at) < daysApart(order.order_at, best.txn_at) ? t : best
    );
    if (affine.length > 1) return { txnId: nearest.id, confidence: "low" };
    const gap = daysApart(order.order_at, nearest.txn_at);
    return { txnId: nearest.id, confidence: gap <= 2 ? "high" : "medium" };
  }

  // No brand-name affinity (e.g. Postbox → bank descriptor "hourglass", or a
  // D2C brand billing via Shopflo/PayU as "Dileep Esse"/"Payu"): fall back to
  // amount + time alone. A UNIQUE exact-amount hit is a strong signal on its own
  // — KP's data shows exact amounts match the right charge ~99% of the time, and
  // an order email lands within a minute of the charge. So:
  //   • within the same-purchase window (≤5 min) → 'high', auto-confirmed: the
  //     charge and the confirmation email are effectively simultaneous, an
  //     unrecognisable bank descriptor notwithstanding;
  //   • same-/next-day (≤2 days) → 'medium' ("likely");
  //   • wider gap → 'low' ("possible", for review).
  // Two+ candidates with no name signal → refuse (the uniqueness guard above).
  if (sameAmount.length !== 1) return null;
  const gap = daysApart(order.order_at, sameAmount[0].txn_at);
  if (gap <= WINDOW_TIGHT_DAYS) return { txnId: sameAmount[0].id, confidence: "high" };
  return { txnId: sameAmount[0].id, confidence: gap <= 2 ? "medium" : "low" };
}

/**
 * Match-priority rank for the sync/audit loop: the RICHEST order claims a
 * transaction first, so a merchant's own email (with items) always wins over a
 * payment-gateway confirmation for the same charge.
 *   3 = merchant email WITH item detail (Postbox, Swiggy, …)
 *   2 = merchant email, no items (marketplace receipt without a line list)
 *   1 = generic merchant receipt
 *   0 = payment gateway (Razorpay) — a signal only; fills a txn nothing else did
 * Higher first. Razorpay never displaces a real merchant order.
 */
export function orderMatchRank(o: { source: OrderSource; itemsCount: number }): number {
  if (o.source === "razorpay") return 0;
  if (o.source === "generic") return 1;
  return o.itemsCount > 0 ? 3 : 2;
}
