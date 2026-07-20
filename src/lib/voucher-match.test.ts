// Boundary tests for voucher → card-charge matching. Real purchases include
// both discounts and convenience fees, and bulk emails aggregate many codes.

import { describe, it, expect } from "vitest";
import { matchVoucherBatchToCharge, matchVoucherToCharge, type VoucherLite } from "./voucher-match";
import type { TxnLite } from "./order-match";

const voucher = (over: Partial<VoucherLite> = {}): VoucherLite => ({
  faceValue: 2000,
  purchasedAt: "2026-06-22T09:24:00Z",
  ...over,
});

const txn = (over: Partial<TxnLite> = {}): TxnLite => ({
  id: "t1",
  amount_inr: 2000,
  txn_at: "2026-06-22T09:24:37Z",
  merchant: "GYFTR VIA SMARTBUY",
  txn_type: "debit",
  ...over,
});

describe("matchVoucherToCharge — the happy path", () => {
  it("matches a paid-in-full voucher to its same-instant GYFTR charge (high)", () => {
    const r = matchVoucherToCharge(voucher(), [txn()]);
    expect(r).toEqual({ txnId: "t1", confidence: "high" });
  });

  it("matches a DISCOUNTED voucher (charge < face) — the case exact-amount would miss", () => {
    const r = matchVoucherToCharge(voucher({ faceValue: 2000 }), [txn({ amount_inr: 1900 })]);
    expect(r).toEqual({ txnId: "t1", confidence: "high" });
  });
});

describe("matchVoucherToCharge — guards", () => {
  it("never pairs with a charge beyond the bounded fee envelope", () => {
    const r = matchVoucherToCharge(voucher({ faceValue: 2000 }), [txn({ amount_inr: 2300 })]);
    expect(r).toBeNull();
  });

  it("ignores a same-amount, same-time charge that ISN'T a Gyftr descriptor", () => {
    const r = matchVoucherToCharge(voucher(), [txn({ merchant: "AMAZON PAY INDIA" })]);
    expect(r).toBeNull();
  });

  it("ignores credit (refund) transactions", () => {
    const r = matchVoucherToCharge(voucher(), [txn({ txn_type: "credit" })]);
    expect(r).toBeNull();
  });

  it("ignores a Gyftr charge outside the time window", () => {
    const r = matchVoucherToCharge(voucher(), [txn({ txn_at: "2026-06-26T09:24:00Z" })]);
    expect(r).toBeNull();
  });

  it("does not reuse an already-claimed charge", () => {
    const r = matchVoucherToCharge(voucher(), [txn()], new Set(["t1"]));
    expect(r).toBeNull();
  });
});

describe("matchVoucherToCharge — multiple candidates", () => {
  it("picks the nearest-in-time Gyftr charge when several sit in the window", () => {
    const r = matchVoucherToCharge(voucher(), [
      txn({ id: "far", txn_at: "2026-06-22T15:00:00Z" }),
      txn({ id: "near", txn_at: "2026-06-22T09:25:00Z" }),
    ]);
    expect(r?.txnId).toBe("near");
    expect(r?.confidence).toBe("high"); // 1 min apart
  });

  it("two vouchers + two charges: each claims its own once 'used' is tracked", () => {
    const txns: TxnLite[] = [
      txn({ id: "c1", amount_inr: 2000, txn_at: "2026-06-22T09:24:37Z" }),
      txn({ id: "c2", amount_inr: 500, txn_at: "2026-06-22T09:26:10Z" }),
    ];
    const used = new Set<string>();
    const v1 = matchVoucherToCharge(voucher({ faceValue: 2000, purchasedAt: "2026-06-22T09:24:00Z" }), txns, used);
    used.add(v1!.txnId);
    const v2 = matchVoucherToCharge(voucher({ faceValue: 500, purchasedAt: "2026-06-22T09:26:00Z" }), txns, used);
    expect(v1?.txnId).toBe("c1");
    expect(v2?.txnId).toBe("c2");
  });
});

describe("matchVoucherBatchToCharge — real Gyftr purchase shapes", () => {
  it("matches one aggregate charge to a multi-voucher email", () => {
    const r = matchVoucherBatchToCharge(
      { faceValue: 16_000, purchasedAt: "2026-06-07T16:12:31Z", voucherCount: 10 },
      [txn({ amount_inr: 16_000, txn_at: "2026-06-07T16:12:40Z" })]
    );
    expect(r).toEqual({ txnId: "t1", confidence: "high" });
  });

  it("accepts an observed convenience fee above face value", () => {
    expect(matchVoucherBatchToCharge(
      { faceValue: 10_000, purchasedAt: "2026-07-03T04:39:29Z", voucherCount: 1 },
      [txn({ amount_inr: 10_413, txn_at: "2026-07-03T04:39:30Z" })]
    )).toEqual({ txnId: "t1", confidence: "high" });
  });

  it("refuses charges outside the bounded discount/fee envelope", () => {
    const batch = { faceValue: 10_000, purchasedAt: "2026-07-03T04:39:29Z", voucherCount: 1 };
    expect(matchVoucherBatchToCharge(batch, [txn({ amount_inr: 7_000 })])).toBeNull();
    expect(matchVoucherBatchToCharge(batch, [txn({ amount_inr: 11_500 })])).toBeNull();
  });

  it("refuses an indistinguishable duplicate charge", () => {
    const batch = { faceValue: 5_000, purchasedAt: "2026-01-01T00:00:00Z", voucherCount: 1 };
    expect(matchVoucherBatchToCharge(batch, [
      txn({ id: "a", amount_inr: 4_875, txn_at: "2026-01-01T00:00:05Z" }),
      txn({ id: "b", amount_inr: 4_875, txn_at: "2026-01-01T00:00:05Z" }),
    ])).toBeNull();
  });
});
