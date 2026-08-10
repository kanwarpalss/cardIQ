// Boundary tests for order→transaction matching. The matcher handles money
// and can mislabel a stranger's-looking spend if it guesses — every rule in
// order-match.ts has a failing case here.

import { describe, it, expect } from "vitest";
import { matchOrderToTxn, matchSplitOrderToTxn, type TxnLite, type OrderLite } from "./order-match";

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

  it("matches the direct-card portion of an explicitly parsed split", () => {
    const m = matchOrderToTxn(
      order({ source: "shopify", merchant_name: "Birkenstock", total_amount: 5793, card_paid_amount: 793 }),
      [txn({ merchant: "Birkenstock India", amount_inr: 793 })]
    );
    expect(m).toEqual({ txnId: "t1", confidence: "high" });
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

  it("no affinity + unique exact amount + within 5 min → HIGH (same-purchase: Ellementry ↔ 'Dileep Esse')", () => {
    // Real 2026-07-14 case: bank descriptor 'Dileep Esse' (Shopflo's settlement
    // entity) shares no token with 'ellementry', but the charge and the order
    // email are 3 s apart and the ₹2,469 amount is a unique exact hit — the same
    // same-purchase signal dedup already trusts. Auto-confirm, don't park it.
    const m = matchOrderToTxn(
      order({ source: "shopify", merchant_name: "ellementry", total_amount: 2469, order_at: "2026-07-13T20:44:29Z" }),
      [txn({ merchant: "Dileep Esse", amount_inr: 2469, txn_at: "2026-07-13T20:44:26Z" })]
    );
    expect(m).toEqual({ txnId: "t1", confidence: "high" });
  });

  it("tight-window HIGH boundary: exactly 5 min → high, one second past → medium", () => {
    const base = { source: "generic" as const, merchant_name: "Acme", total_amount: 2469, order_at: "2026-07-13T20:40:00Z" };
    expect(matchOrderToTxn(order(base), [txn({ merchant: "Zzz", amount_inr: 2469, txn_at: "2026-07-13T20:45:00Z" })]))
      .toEqual({ txnId: "t1", confidence: "high" });   // 5 min exactly
    expect(matchOrderToTxn(order(base), [txn({ merchant: "Zzz", amount_inr: 2469, txn_at: "2026-07-13T20:45:01Z" })]))
      .toEqual({ txnId: "t1", confidence: "medium" });  // 5 min + 1 s → back to review
  });

  it("tight-window HIGH still needs UNIQUENESS: two same-amount txns within 5 min → refuses", () => {
    // The auto-confirm shortcut must never fire when the amount is ambiguous.
    const base = { source: "generic" as const, merchant_name: "Acme", total_amount: 2469, order_at: "2026-07-13T20:44:00Z" };
    const m = matchOrderToTxn(order(base), [
      txn({ id: "a", merchant: "Zzz", amount_inr: 2469, txn_at: "2026-07-13T20:44:30Z" }),
      txn({ id: "b", merchant: "Yyy", amount_inr: 2469, txn_at: "2026-07-13T20:45:30Z" }),
    ]);
    expect(m).toBeNull();
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

describe("matchSplitOrderToTxn — conservative voucher inference", () => {
  const birkenstock = order({
    source: "shopify", merchant_name: "BIRKENSTOCK", total_amount: 5793,
    order_at: "2026-07-15T19:21:11Z",
  });

  it("reconstructs the real ₹5,000 voucher + ₹793 card example", () => {
    expect(matchSplitOrderToTxn(
      birkenstock,
      [txn({ merchant: "Birkenstock India", amount_inr: 793, txn_at: "2026-07-15T19:20:00Z" })],
      5000
    )).toEqual({ txnId: "t1", confidence: "high", cardAmount: 793, voucherAmount: 5000 });
  });

  it("refuses without enough compatible voucher balance", () => {
    expect(matchSplitOrderToTxn(birkenstock, [txn({ merchant: "Birkenstock India", amount_inr: 793 })], 4999)).toBeNull();
  });

  it("refuses a smaller unrelated charge even if the arithmetic works", () => {
    expect(matchSplitOrderToTxn(birkenstock, [txn({ merchant: "Some Other Store", amount_inr: 793 })], 5000)).toBeNull();
  });

  it("refuses two plausible merchant charges rather than guessing", () => {
    expect(matchSplitOrderToTxn(birkenstock, [
      txn({ id: "a", merchant: "Birkenstock India", amount_inr: 793 }),
      txn({ id: "b", merchant: "Birkenstock", amount_inr: 1293 }),
    ], 5000)).toBeNull();
  });

  it("refuses invalid dates and non-finite money", () => {
    expect(matchSplitOrderToTxn(
      order({ ...birkenstock, order_at: "2026-02-30T19:21:11Z" }),
      [txn({ merchant: "Birkenstock India", amount_inr: 793 })],
      5000
    )).toBeNull();
    expect(matchSplitOrderToTxn(
      birkenstock,
      [txn({ merchant: "Birkenstock India", amount_inr: Number.POSITIVE_INFINITY })],
      5000
    )).toBeNull();
    expect(matchSplitOrderToTxn(
      birkenstock,
      [txn({ merchant: "Birkenstock India", amount_inr: 793 })],
      Number.POSITIVE_INFINITY
    )).toBeNull();
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

  it("uses the refund amount even if the original split card portion was retained", () => {
    const splitRefund = order({ source: "amazon", kind: "refund", total_amount: 100, card_paid_amount: 20 });
    expect(matchOrderToTxn(
      splitRefund,
      [txn({ txn_type: "credit", amount_inr: 100 })]
    )).toEqual({ txnId: "t1", confidence: "medium" });
    expect(matchOrderToTxn(
      splitRefund,
      [txn({ txn_type: "credit", amount_inr: 20 })]
    )).toBeNull();
  });
});

describe("matchOrderToTxn — missing or invalid payment evidence", () => {
  const delivered = order({ source: "amazon", kind: "order", total_amount: null });

  it("never associates an amount-less Amazon delivery notice", () => {
    expect(matchOrderToTxn(delivered, [txn({ merchant: "AMZN Mktp IN", amount_inr: 999 })])).toBeNull();
  });

  it("rejects zero, negative, NaN, and infinite order amounts", () => {
    for (const total_amount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(matchOrderToTxn(order({ total_amount }), [txn({ amount_inr: total_amount })])).toBeNull();
    }
  });

  it("rejects zero, negative, NaN, and infinite transaction amounts", () => {
    for (const amount_inr of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(matchOrderToTxn(order({}), [txn({ amount_inr })])).toBeNull();
    }
  });

  it("an explicit zero card portion does not fall back to the full order total", () => {
    expect(matchOrderToTxn(
      order({ total_amount: 5_000, card_paid_amount: 0 }),
      [txn({ amount_inr: 5_000 })]
    )).toBeNull();
  });

  it("invalid order or transaction dates never associate", () => {
    expect(matchOrderToTxn(order({ order_at: "not-a-date" }), [txn({})])).toBeNull();
    expect(matchOrderToTxn(order({}), [txn({ txn_at: "not-a-date" })])).toBeNull();
    expect(matchOrderToTxn(order({ order_at: "2026-02-30T05:20:00Z" }), [txn({})])).toBeNull();
    expect(matchOrderToTxn(order({ order_at: "2026-07-06T05:20:00" }), [txn({})])).toBeNull();
  });

  it("rejects runtime string money instead of relying on JavaScript coercion", () => {
    expect(matchOrderToTxn(
      order({ total_amount: "365" as unknown as number }),
      [txn({ amount_inr: 365 })]
    )).toBeNull();
    expect(matchOrderToTxn(
      order({ total_amount: 365 }),
      [txn({ amount_inr: "365" as unknown as number })]
    )).toBeNull();
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
    expect(matchOrderToTxn(order({ total_amount: 365 }), [txn({ amount_inr: 365.7500001 })])).toBeNull();
  });

  it("exactly 5.0 days apart matches; one millisecond past does not", () => {
    expect(matchOrderToTxn(order({ order_at: "2026-07-06T05:20:00.000Z" }), [txn({ txn_at: "2026-07-11T05:20:00.000Z" })]))
      .toEqual({ txnId: "t1", confidence: "medium" });
    expect(matchOrderToTxn(order({ order_at: "2026-07-06T05:20:00.000Z" }), [txn({ txn_at: "2026-07-11T05:20:00.001Z" })]))
      .toBeNull();
  });

  it("₹0 is not a real charge association", () => {
    expect(matchOrderToTxn(order({ total_amount: 0 }), [txn({ amount_inr: 0 })])).toBeNull();
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
