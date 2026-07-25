// Boundary tests for the inferred-FIFO layer (Invariant #7 v2). The two rules
// that MUST hold: evidence always claims balance before a guess, and a
// card-matched order is never voucher-attributed (no double-count).

import { describe, it, expect } from "vitest";
import {
  isInferredFifoEligible,
  reconcileWithInferred,
  type InferredEligibleOrder,
  type VoucherPurchase,
  type VoucherPaidOrder,
} from "./voucher-bridge";

const base: InferredEligibleOrder = {
  kind: "order", duplicateOf: null, reviewStatus: "unmatched", txnId: null,
  voucherPaidAmount: null, source: "amazon", total: 500, itemCount: 2,
};

describe("isInferredFifoEligible", () => {
  it("a real, unmatched, itemised order with a positive total qualifies", () => {
    expect(isInferredFifoEligible(base)).toBe(true);
  });
  it("EXCLUDES a card-matched order (has txnId) — never double-count a card spend", () => {
    expect(isInferredFifoEligible({ ...base, txnId: "txn-1" })).toBe(false);
  });
  it("EXCLUDES an order already evidence-attributed (voucherPaidAmount set)", () => {
    expect(isInferredFifoEligible({ ...base, voucherPaidAmount: 500 })).toBe(false);
    expect(isInferredFifoEligible({ ...base, voucherPaidAmount: 0 })).toBe(false); // 0 is still "stated"
  });
  it("EXCLUDES duplicates, rejected reviews, razorpay echoes, refunds", () => {
    expect(isInferredFifoEligible({ ...base, duplicateOf: "o9" })).toBe(false);
    expect(isInferredFifoEligible({ ...base, reviewStatus: "rejected" })).toBe(false);
    expect(isInferredFifoEligible({ ...base, source: "razorpay" })).toBe(false);
    expect(isInferredFifoEligible({ ...base, kind: "refund" })).toBe(false);
  });
  it("EXCLUDES thin rows: zero total, negative total, or no item detail", () => {
    expect(isInferredFifoEligible({ ...base, total: 0 })).toBe(false);
    expect(isInferredFifoEligible({ ...base, total: -100 })).toBe(false);
    expect(isInferredFifoEligible({ ...base, itemCount: 0 })).toBe(false);
  });
});

const v = (id: string, brand: string, faceValue: number, purchasedAt: string, cardTxnId = "c-" + id): VoucherPurchase =>
  ({ id, brand, faceValue, purchasedAt, cardTxnId });
const o = (id: string, brand: string, amount: number, orderedAt: string): VoucherPaidOrder =>
  ({ id, brand, amount, orderedAt });

describe("reconcileWithInferred", () => {
  it("evidence claims balance FIRST; inferred draws only the remainder", () => {
    const vouchers = [v("V", "amazon", 1000, "2026-01-01")];
    const evidence = [o("ev", "amazon", 400, "2026-01-10")];   // receipt-stated ₹400
    const inferred = [o("inf", "amazon", 1000, "2026-01-20")]; // whole order, guessed
    const res = reconcileWithInferred(vouchers, evidence, inferred);
    const state = res.vouchers.find((x) => x.voucherId === "V")!;
    expect(state.drawn).toBe(1000);
    expect(state.remaining).toBe(0);
    const inf = res.orders.find((a) => a.orderId === "inf")!;
    expect(inf.attributed).toBe(600);   // only the ₹600 evidence left behind
    expect(inf.shortfall).toBe(400);    // the rest wasn't voucher-covered
  });

  it("pooled brand: sequential FIFO drawdown across multiple inferred orders", () => {
    const vouchers = [v("V", "amazon", 5000, "2026-01-01")];
    const inferred = [
      o("o1", "amazon", 2000, "2026-01-05"),
      o("o2", "amazon", 1000, "2026-02-05"),
    ];
    const res = reconcileWithInferred(vouchers, [], inferred);
    expect(res.vouchers[0].drawn).toBe(3000);
    expect(res.vouchers[0].remaining).toBe(2000);
    expect(res.orders.map((a) => [a.orderId, a.attributed])).toEqual([["o1", 2000], ["o2", 1000]]);
  });

  it("an inferred order placed BEFORE the voucher existed draws nothing", () => {
    const vouchers = [v("V", "amazon", 5000, "2026-06-01")];
    const inferred = [o("early", "amazon", 1000, "2026-01-01")]; // months before
    const res = reconcileWithInferred(vouchers, [], inferred);
    expect(res.vouchers[0].drawn).toBe(0);
    expect(res.orders[0].attributed).toBe(0);
    expect(res.orders[0].status).toBe("unattributed");
  });

  it("cross-brand isolation: an Amazon order never touches a Swiggy voucher", () => {
    const vouchers = [v("S", "swiggy", 2000, "2026-01-01")];
    const inferred = [o("amz", "amazon", 500, "2026-02-01")];
    const res = reconcileWithInferred(vouchers, [], inferred);
    expect(res.vouchers[0].drawn).toBe(0);       // Swiggy voucher untouched
    expect(res.orders[0].attributed).toBe(0);
  });

  it("evidence that fully drains a voucher leaves nothing for inferred", () => {
    const vouchers = [v("V", "amazon", 1000, "2026-01-01")];
    const evidence = [o("ev", "amazon", 1000, "2026-01-05")];
    const inferred = [o("inf", "amazon", 800, "2026-01-10")];
    const res = reconcileWithInferred(vouchers, evidence, inferred);
    expect(res.vouchers[0].remaining).toBe(0);
    expect(res.orders.find((a) => a.orderId === "inf")!.attributed).toBe(0);
  });
});
