// Boundary tests for order→transaction matching. The matcher handles money
// and can mislabel a stranger's-looking spend if it guesses — every rule in
// order-match.ts has a failing case here.

import { describe, it, expect } from "vitest";
import { matchOrderToTxn, type TxnLite, type OrderLite } from "./order-match";

const txn = (over: Partial<TxnLite>): TxnLite => ({
  id: "t1",
  amount_inr: 365,
  txn_at: "2026-07-06T05:30:00Z",
  merchant: "Swiggy",
  txn_type: "debit",
  ...over,
});

const order = (over: Partial<OrderLite>): OrderLite => ({
  source: "swiggy",
  kind: "order",
  total_amount: 365,
  order_at: "2026-07-06T05:20:00Z",
  ...over,
});

describe("matchOrderToTxn — amount-bearing orders", () => {
  it("high: exact amount + affinity + unique + same day", () => {
    expect(matchOrderToTxn(order({}), [txn({})])).toEqual({ txnId: "t1", confidence: "high" });
  });

  it("medium: exact amount + affinity + unique + 4 days apart", () => {
    const m = matchOrderToTxn(order({}), [txn({ txn_at: "2026-07-10T05:20:00Z" })]);
    expect(m).toEqual({ txnId: "t1", confidence: "medium" });
  });

  it("no match beyond the 5-day window", () => {
    expect(matchOrderToTxn(order({}), [txn({ txn_at: "2026-07-12T05:20:00Z" })])).toBeNull();
  });

  it("amount tolerance is ₹0.75 (bank paise rounding), not more", () => {
    expect(matchOrderToTxn(order({ total_amount: 365.33 }), [txn({ amount_inr: 365 })])).not.toBeNull();
    expect(matchOrderToTxn(order({}), [txn({ amount_inr: 367 })])).toBeNull();
  });

  it("low + nearest when TWO affine txns share the amount (ambiguity never gets high)", () => {
    const m = matchOrderToTxn(order({}), [
      txn({ id: "far",  txn_at: "2026-07-09T05:20:00Z" }),
      txn({ id: "near", txn_at: "2026-07-06T08:00:00Z" }),
    ]);
    expect(m).toEqual({ txnId: "near", confidence: "low" });
  });

  it("no affinity + paise amount + unique + same-day → medium (renamed Zomato txn)", () => {
    const m = matchOrderToTxn(
      order({ source: "zomato", total_amount: 747.33 }),
      [txn({ merchant: "YUKI", amount_inr: 747.33 })]
    );
    expect(m).toEqual({ txnId: "t1", confidence: "medium" });
  });

  it("no affinity + round amount + UNIQUE + same-day → medium (exact amount is a strong signal)", () => {
    // The D2C case: the order's brand doesn't appear in the bank descriptor,
    // but there's exactly one exact-amount debit that day. Old code threw this
    // away for round amounts; now a same-day unique hit links at 'medium'.
    expect(matchOrderToTxn(order({}), [txn({ merchant: "Random Store" })]))
      .toEqual({ txnId: "t1", confidence: "medium" });
  });

  it("no affinity + unique but >2 days apart → low (for review, not auto-confident)", () => {
    // order_at defaults to 2026-07-06; a debit 4 days later still matches on
    // unique amount, but the loose timing keeps it 'low' → surfaced for review.
    const m = matchOrderToTxn(order({}), [txn({ merchant: "Random Store", txn_at: "2026-07-10T05:20:00Z" })]);
    expect(m).toEqual({ txnId: "t1", confidence: "low" });
  });

  it("no affinity + round amount + MULTIPLE candidates → refuses to guess", () => {
    const m = matchOrderToTxn(order({}), [
      txn({ id: "a", merchant: "Store A" }),
      txn({ id: "b", merchant: "Store B", txn_at: "2026-07-07T05:20:00Z" }),
    ]);
    expect(m).toBeNull();
  });

  it("D2C brand-token affinity: Inmarwar order ↔ 'Raz*inmarwar' descriptor → high", () => {
    const m = matchOrderToTxn(
      order({ source: "shopify", merchant_name: "Inmarwar", total_amount: 23999 }),
      [txn({ merchant: "Raz*inmarwar", amount_inr: 23999 })]
    );
    expect(m).toEqual({ txnId: "t1", confidence: "high" });
  });

  it("D2C, no name overlap: Postbox order ↔ 'hourglass' descriptor links same-day → medium", () => {
    const m = matchOrderToTxn(
      order({ source: "shopify", merchant_name: "The Postbox", total_amount: 1499 }),
      [txn({ merchant: "hourglass", amount_inr: 1499 })]
    );
    expect(m).toEqual({ txnId: "t1", confidence: "medium" });
  });

  it("stopword tokens never bridge unrelated brands (Razorpay prefix ≠ affinity → still medium, not high)", () => {
    // 'Acme' order vs 'Raz*Zeta' txn: 'raz' is a stopword, so NO false HIGH —
    // it links on unique same-day amount only, at 'medium'.
    const m = matchOrderToTxn(
      order({ source: "generic", merchant_name: "Acme", total_amount: 500 }),
      [txn({ merchant: "Raz*Zeta", amount_inr: 500 })]
    );
    expect(m).toEqual({ txnId: "t1", confidence: "medium" });
  });

  it("no affinity + paise but MULTIPLE candidates → refuses to guess", () => {
    const m = matchOrderToTxn(
      order({ source: "zomato", total_amount: 747.33 }),
      [
        txn({ id: "a", merchant: "YUKI", amount_inr: 747.33 }),
        txn({ id: "b", merchant: "Cafe", amount_inr: 747.33 }),
      ]
    );
    expect(m).toBeNull();
  });

  it("order emails never match credit txns", () => {
    expect(matchOrderToTxn(order({}), [txn({ txn_type: "credit" })])).toBeNull();
  });

  it("affinity works on parent-company merchant strings (Eternal = Zomato)", () => {
    const m = matchOrderToTxn(
      order({ source: "zomato", total_amount: 612.45 }),
      [txn({ merchant: "ETERNAL LIMITED", amount_inr: 612.45 })]
    );
    expect(m?.confidence).toBe("high");
  });
});

describe("matchOrderToTxn — refunds", () => {
  const refund = order({ source: "amazon", kind: "refund", total_amount: 69.42 });

  it("matches CREDIT txns only", () => {
    const credit = txn({ id: "c", merchant: "AMAZON PAY", amount_inr: 69.42, txn_type: "credit" });
    const debit  = txn({ id: "d", merchant: "AMAZON PAY", amount_inr: 69.42, txn_type: "debit" });
    expect(matchOrderToTxn(refund, [debit])).toBeNull();
    expect(matchOrderToTxn(refund, [debit, credit])).toEqual({ txnId: "c", confidence: "high" });
  });
});

describe("matchOrderToTxn — amount-less orders (Amazon Delivered)", () => {
  const delivered = order({ source: "amazon", kind: "order", total_amount: null });

  it("unique affine candidate in ±4 days → low, never higher", () => {
    const m = matchOrderToTxn(delivered, [txn({ merchant: "AMZN Mktp IN", amount_inr: 999 })]);
    expect(m).toEqual({ txnId: "t1", confidence: "low" });
  });

  it("two affine candidates → refuses to guess", () => {
    const m = matchOrderToTxn(delivered, [
      txn({ id: "a", merchant: "Amazon" }),
      txn({ id: "b", merchant: "Amazon Pay" }),
    ]);
    expect(m).toBeNull();
  });

  it("no affinity → no match, regardless of dates", () => {
    expect(matchOrderToTxn(delivered, [txn({ merchant: "Flipkart" })])).toBeNull();
  });

  it("outside ±4 days → no match", () => {
    expect(matchOrderToTxn(delivered, [txn({ merchant: "Amazon", txn_at: "2026-07-11T05:20:00Z" })])).toBeNull();
  });
});

describe("matchOrderToTxn — claimed transactions", () => {
  it("a txn already claimed by another order is invisible", () => {
    expect(matchOrderToTxn(order({}), [txn({})], new Set(["t1"]))).toBeNull();
  });

  it("falls through to the next candidate when the best is claimed", () => {
    const m = matchOrderToTxn(
      order({}),
      [txn({ id: "claimed" }), txn({ id: "free", txn_at: "2026-07-07T05:20:00Z" })],
      new Set(["claimed"])
    );
    expect(m).toEqual({ txnId: "free", confidence: "high" });
  });

  it("empty txn list → null (first sync, no transactions yet)", () => {
    expect(matchOrderToTxn(order({}), [])).toBeNull();
  });
});

// ── Boundary locks (boundary-prover, 2026-07-11) — exact edges pinned. ──────

describe("matchOrderToTxn — exact boundaries", () => {
  it("amount diff of exactly ₹0.75 matches; ₹0.76 does not", () => {
    expect(matchOrderToTxn(order({ total_amount: 365 }), [txn({ amount_inr: 365.75 })])).not.toBeNull();
    expect(matchOrderToTxn(order({ total_amount: 365 }), [txn({ amount_inr: 365.76 })])).toBeNull();
  });

  it("exactly 5.0 days apart matches; a minute past does not", () => {
    expect(matchOrderToTxn(order({ order_at: "2026-07-06T05:20:00Z" }), [txn({ txn_at: "2026-07-11T05:20:00Z" })]))
      .toEqual({ txnId: "t1", confidence: "medium" });
    expect(matchOrderToTxn(order({ order_at: "2026-07-06T05:20:00Z" }), [txn({ txn_at: "2026-07-11T05:21:00Z" })]))
      .toBeNull();
  });

  it("total_amount 0 goes down the amount-bearing path (== null check, not truthy)", () => {
    // A ₹0 order matching a ₹0 txn at 'high' proves the amount path ran —
    // the amount-less path can never return better than 'low'.
    const m = matchOrderToTxn(order({ total_amount: 0 }), [txn({ amount_inr: 0 })]);
    expect(m).toEqual({ txnId: "t1", confidence: "high" });
  });
});

describe("orderMatchRank — merchant-first priority", () => {
  it("merchant email with items outranks a Razorpay gateway confirmation", async () => {
    const { orderMatchRank } = await import("./order-match");
    expect(orderMatchRank({ source: "shopify", itemsCount: 3 })).toBeGreaterThan(
      orderMatchRank({ source: "razorpay", itemsCount: 0 })
    );
    // Razorpay is always last — a pure signal, never displaces a real order.
    expect(orderMatchRank({ source: "razorpay", itemsCount: 0 })).toBe(0);
    // Item-rich beats item-less of the same tier.
    expect(orderMatchRank({ source: "swiggy", itemsCount: 2 })).toBeGreaterThan(
      orderMatchRank({ source: "swiggy", itemsCount: 0 })
    );
  });
});

describe("reviewStatusFor — auto-confirm policy (migration 014)", () => {
  it("only 'high' auto-confirms; medium and low wait for review", async () => {
    const { reviewStatusFor } = await import("./order-match");
    expect(reviewStatusFor("high")).toBe("confirmed");
    expect(reviewStatusFor("medium")).toBe("pending");
    expect(reviewStatusFor("low")).toBe("pending");
  });
});
