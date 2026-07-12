// Voucher → funding card-charge matching (V2 feature C, the voucher bridge).
// Pure logic, no I/O — unit-tested in voucher-match.test.ts.
//
// A Gyftr voucher is bought with one card charge that the bank describes
// distinctively — "GYFTR VIA SMARTBUY" — and issues the voucher in the SAME
// instant (real sample: bank charge 09:24:37, Gyftr email 09:24). That makes
// this a DIFFERENT match problem from a normal order:
//
//   • The descriptor always carries "gyftr" — a near-unique bank token, so we
//     don't need amount+name affinity to find the charge.
//   • The charge is ≤ face value: Gyftr often gives a discount, so ₹2000 of
//     voucher may cost ₹1900. The generic matcher (exact amount ±₹0.75) would
//     MISS a discounted buy — hence this dedicated rule.
//   • Issuance and charge share the instant, so nearest-in-time is decisive.
//
// We never pair a voucher with a charge LARGER than its face value (you never
// pay more than face), and we cap the time window tightly.

import type { MatchConfidence, TxnLite } from "./order-match";

export type VoucherLite = {
  /** Spendable balance in INR — the charge is at most this (often less). */
  faceValue: number;
  /** ISO timestamp the voucher was issued (its Gyftr email time). */
  purchasedAt: string;
};

export type VoucherChargeMatch = { txnId: string; confidence: MatchConfidence };

const FACE_TOLERANCE = 0.75; // paise/rounding wiggle above face value
const WINDOW_DAYS = 2; // issuance & charge are same-instant; window absorbs skew
const SAME_INSTANT_MIN = 60; // ≤1h apart ⇒ treat as the same event
const MIN_MS = 60_000;

/** The distinctive bank token for a Gyftr/SmartBuy voucher purchase. */
function isGyftrCharge(merchant: string | null): boolean {
  return /gyftr/i.test(merchant ?? "");
}

function minutesApart(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / MIN_MS;
}

/**
 * Find the card charge that bought this voucher, or null.
 *
 * @param usedTxnIds charges already claimed (by an order or another voucher) —
 *                   one charge is never attributed twice.
 */
export function matchVoucherToCharge(
  voucher: VoucherLite,
  txns: TxnLite[],
  usedTxnIds: ReadonlySet<string> = new Set()
): VoucherChargeMatch | null {
  const candidates = txns.filter(
    (t) =>
      t.txn_type === "debit" &&
      !usedTxnIds.has(t.id) &&
      isGyftrCharge(t.merchant) &&
      t.amount_inr > 0 &&
      t.amount_inr <= voucher.faceValue + FACE_TOLERANCE &&
      minutesApart(voucher.purchasedAt, t.txn_at) <= WINDOW_DAYS * 24 * 60
  );
  if (candidates.length === 0) return null;

  // Nearest-in-time wins — the charge and issuance are the same event.
  const nearest = candidates.reduce((best, t) =>
    minutesApart(voucher.purchasedAt, t.txn_at) < minutesApart(voucher.purchasedAt, best.txn_at) ? t : best
  );

  const gapMin = minutesApart(voucher.purchasedAt, nearest.txn_at);
  // Same-instant + a "gyftr" descriptor + charge ≤ face = as certain as it gets.
  // A wider gap or several same-window candidates drops to medium/low for review.
  const confidence: MatchConfidence =
    gapMin <= SAME_INSTANT_MIN ? "high" : candidates.length === 1 ? "medium" : "low";

  return { txnId: nearest.id, confidence };
}
