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
//   • The charge is normally close to aggregate face value: Gyftr often gives
//     a discount, while some SmartBuy purchases include a small fee. The generic
//     matcher (exact amount ±₹0.75) would miss both — hence this dedicated rule.
//   • Issuance and charge share the instant, so nearest-in-time is decisive.
//
// We bound accepted charges to 75–110% of the batch face value and cap the time
// window tightly. A whole issuance email is matched as one purchase batch.

import type { MatchConfidence, TxnLite } from "./order-match";

export type VoucherLite = {
  /** Spendable balance in INR — the charge is at most this (often less). */
  faceValue: number;
  /** ISO timestamp the voucher was issued (its Gyftr email time). */
  purchasedAt: string;
};

/** One Gyftr email is one purchase batch. It can contain many voucher codes
 * funded by a single aggregate card charge. */
export type VoucherBatchLite = VoucherLite & { voucherCount: number };

export type VoucherChargeMatch = { txnId: string; confidence: MatchConfidence };

const FACE_TOLERANCE = 0.75; // paise/rounding wiggle above face value
const MIN_CHARGE_RATIO = 0.75; // promotions/points can discount the batch
const MAX_CHARGE_RATIO = 1.10; // Gyftr/SmartBuy convenience fees observed live
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
  return matchVoucherBatchToCharge(
    { ...voucher, voucherCount: 1 },
    txns,
    usedTxnIds
  );
}

/** Match a whole issuance email to its one aggregate funding charge. */
export function matchVoucherBatchToCharge(
  batch: VoucherBatchLite,
  txns: TxnLite[],
  usedTxnIds: ReadonlySet<string> = new Set()
): VoucherChargeMatch | null {
  const candidates = txns.filter(
    (t) =>
      t.txn_type === "debit" &&
      !usedTxnIds.has(t.id) &&
      isGyftrCharge(t.merchant) &&
      t.amount_inr > 0 &&
      t.amount_inr >= batch.faceValue * MIN_CHARGE_RATIO - FACE_TOLERANCE &&
      t.amount_inr <= batch.faceValue * MAX_CHARGE_RATIO + FACE_TOLERANCE &&
      minutesApart(batch.purchasedAt, t.txn_at) <= WINDOW_DAYS * 24 * 60
  );
  if (candidates.length === 0) return null;

  // Nearest in time wins; equal-time candidates are disambiguated by closeness
  // to the batch face value. A true tie is refused instead of guessing a card.
  const ranked = [...candidates].sort((a, b) =>
    minutesApart(batch.purchasedAt, a.txn_at) - minutesApart(batch.purchasedAt, b.txn_at) ||
    Math.abs(a.amount_inr - batch.faceValue) - Math.abs(b.amount_inr - batch.faceValue) ||
    a.id.localeCompare(b.id)
  );
  const nearest = ranked[0];
  const second = ranked[1];
  if (second &&
      Math.abs(minutesApart(batch.purchasedAt, nearest.txn_at) - minutesApart(batch.purchasedAt, second.txn_at)) < 1 &&
      Math.abs(Math.abs(nearest.amount_inr - batch.faceValue) - Math.abs(second.amount_inr - batch.faceValue)) <= FACE_TOLERANCE) {
    return null;
  }

  const gapMin = minutesApart(batch.purchasedAt, nearest.txn_at);
  // Same-instant + a "gyftr" descriptor + bounded aggregate amount is as
  // certain as it gets.
  // A wider gap or several same-window candidates drops to medium/low for review.
  const confidence: MatchConfidence =
    gapMin <= SAME_INSTANT_MIN ? "high" : candidates.length === 1 ? "medium" : "low";

  return { txnId: nearest.id, confidence };
}
