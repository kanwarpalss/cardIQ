// Boundary tests for the voucher bridge. This reconciles MONEY through a FIFO
// drawdown over DATES — three of the classic footgun ingredients — so every
// rule in voucher-bridge.ts has a case that would fail a naive implementation.

import { describe, it, expect } from "vitest";
import {
  reconcileVouchers,
  normalizeBrand,
  type VoucherPurchase,
  type VoucherPaidOrder,
} from "./voucher-bridge";

const v = (over: Partial<VoucherPurchase>): VoucherPurchase => ({
  id: "v1", brand: "amazon", faceValue: 5000, purchasedAt: "2026-01-01T00:00:00Z", cardTxnId: "card-1", ...over,
});
const o = (over: Partial<VoucherPaidOrder>): VoucherPaidOrder => ({
  id: "o1", brand: "amazon", amount: 1000, orderedAt: "2026-02-01T00:00:00Z", ...over,
});

describe("reconcileVouchers — basic drawdown", () => {
  it("draws an order from a same-brand voucher and reduces its balance", () => {
    const r = reconcileVouchers([v({})], [o({ amount: 1200 })]);
    expect(r.orders[0]).toMatchObject({ status: "attributed", attributed: 1200, shortfall: 0 });
    expect(r.orders[0].draws).toEqual([{ voucherId: "v1", amount: 1200, cardTxnId: "card-1" }]);
    expect(r.vouchers[0]).toMatchObject({ drawn: 1200, remaining: 3800, reconciled: false });
  });

  it("carries the voucher's cardTxnId onto the draw — the order→voucher→card chain", () => {
    const r = reconcileVouchers([v({ cardTxnId: "gyftr-charge-99" })], [o({})]);
    expect(r.orders[0].draws[0].cardTxnId).toBe("gyftr-charge-99");
  });

  it("a voucher drained to (almost) zero is reconciled", () => {
    const r = reconcileVouchers(
      [v({ faceValue: 1000 })],
      [o({ id: "a", amount: 600, orderedAt: "2026-02-01T00:00:00Z" }),
       o({ id: "b", amount: 400, orderedAt: "2026-02-02T00:00:00Z" })]
    );
    expect(r.vouchers[0]).toMatchObject({ drawn: 1000, remaining: 0, reconciled: true });
    expect(r.orders.every((x) => x.status === "attributed")).toBe(true);
  });

  it("a voucher only partly spent keeps its remaining balance and is NOT reconciled", () => {
    const r = reconcileVouchers([v({ faceValue: 5000 })], [o({ amount: 1000 })]);
    expect(r.vouchers[0]).toMatchObject({ remaining: 4000, reconciled: false });
  });
});

describe("reconcileVouchers — spanning & shortfall", () => {
  it("an order larger than one voucher spans the next (FIFO), splitting the draw", () => {
    const r = reconcileVouchers(
      [v({ id: "v1", faceValue: 1000, purchasedAt: "2026-01-01T00:00:00Z" }),
       v({ id: "v2", faceValue: 5000, purchasedAt: "2026-01-05T00:00:00Z" })],
      [o({ amount: 1500 })]
    );
    expect(r.orders[0].draws).toEqual([
      { voucherId: "v1", amount: 1000, cardTxnId: "card-1" },
      { voucherId: "v2", amount: 500, cardTxnId: "card-1" },
    ]);
    expect(r.orders[0].status).toBe("attributed");
  });

  it("never over-draws a voucher: an uncovered order records a shortfall, not a false link", () => {
    const r = reconcileVouchers([v({ faceValue: 1000 })], [o({ amount: 2500 })]);
    expect(r.orders[0]).toMatchObject({ attributed: 1000, shortfall: 1500, status: "partial" });
    expect(r.vouchers[0].remaining).toBe(0); // capped — never negative
  });

  it("an order with no available voucher balance is unattributed", () => {
    const r = reconcileVouchers([], [o({})]);
    expect(r.orders[0]).toMatchObject({ attributed: 0, shortfall: 1000, status: "unattributed", draws: [] });
  });
});

describe("reconcileVouchers — eligibility by date + grace", () => {
  it("a voucher bought AFTER the order (beyond grace) cannot fund it", () => {
    const r = reconcileVouchers(
      [v({ purchasedAt: "2026-03-01T00:00:00Z" })],
      [o({ orderedAt: "2026-02-01T00:00:00Z" })]
    );
    expect(r.orders[0].status).toBe("unattributed");
  });

  it("a voucher bought a few hours after the order still funds it (email-skew grace)", () => {
    const r = reconcileVouchers(
      [v({ purchasedAt: "2026-02-01T05:00:00Z" })],
      [o({ orderedAt: "2026-02-01T00:00:00Z" })] // 5h earlier, within 24h grace
    );
    expect(r.orders[0].status).toBe("attributed");
  });

  it("respects a custom (tighter) grace window", () => {
    const r = reconcileVouchers(
      [v({ purchasedAt: "2026-02-01T05:00:00Z" })],
      [o({ orderedAt: "2026-02-01T00:00:00Z" })],
      { graceHours: 1 }
    );
    expect(r.orders[0].status).toBe("unattributed"); // 5h > 1h grace
  });
});

describe("reconcileVouchers — FIFO across multiple vouchers/orders", () => {
  it("drains the OLDEST voucher first regardless of input order", () => {
    const r = reconcileVouchers(
      [v({ id: "new", faceValue: 5000, purchasedAt: "2026-01-10T00:00:00Z" }),
       v({ id: "old", faceValue: 5000, purchasedAt: "2026-01-01T00:00:00Z" })],
      [o({ amount: 1000, orderedAt: "2026-02-01T00:00:00Z" })]
    );
    expect(r.orders[0].draws[0].voucherId).toBe("old");
    expect(r.vouchers.find((x) => x.voucherId === "old")!.drawn).toBe(1000);
    expect(r.vouchers.find((x) => x.voucherId === "new")!.drawn).toBe(0);
  });

  it("attributes earlier orders to earlier vouchers across a full sequence", () => {
    const r = reconcileVouchers(
      [v({ id: "v1", faceValue: 1000, purchasedAt: "2026-01-01T00:00:00Z" }),
       v({ id: "v2", faceValue: 1000, purchasedAt: "2026-01-15T00:00:00Z" })],
      [o({ id: "o1", amount: 800, orderedAt: "2026-02-01T00:00:00Z" }),
       o({ id: "o2", amount: 800, orderedAt: "2026-02-10T00:00:00Z" })]
    );
    // o1 fully from v1 (200 left); o2 takes v1's last 200 then 600 from v2.
    expect(r.orders.find((x) => x.orderId === "o1")!.draws).toEqual([{ voucherId: "v1", amount: 800, cardTxnId: "card-1" }]);
    expect(r.orders.find((x) => x.orderId === "o2")!.draws).toEqual([
      { voucherId: "v1", amount: 200, cardTxnId: "card-1" },
      { voucherId: "v2", amount: 600, cardTxnId: "card-1" },
    ]);
  });
});

describe("reconcileVouchers — brand isolation & normalization", () => {
  it("a voucher NEVER funds a different brand's order", () => {
    const r = reconcileVouchers([v({ brand: "amazon" })], [o({ brand: "swiggy", amount: 500 })]);
    expect(r.orders[0].status).toBe("unattributed");
    expect(r.vouchers[0].drawn).toBe(0);
  });

  it("normalizes aliases so an 'Amazon Pay' voucher funds an 'amazon.in' order", () => {
    const r = reconcileVouchers([v({ brand: "Amazon Pay" })], [o({ brand: "amazon.in", amount: 500 })]);
    expect(r.orders[0].status).toBe("attributed");
  });

  it("normalizeBrand collapses known wallet suffixes", () => {
    expect(normalizeBrand("Swiggy Money")).toBe("swiggy");
    expect(normalizeBrand("BigBasket Wallet")).toBe("bigbasket");
    expect(normalizeBrand("Grofers")).toBe("blinkit");
    expect(normalizeBrand("  AMAZON.IN ")).toBe("amazon");
  });

  it("an unknown brand reconciles against its own vouchers but not across", () => {
    const r = reconcileVouchers(
      [{ id: "vv", brand: "NykaaFashion", faceValue: 1000, purchasedAt: "2026-01-01T00:00:00Z", cardTxnId: "c" }],
      [{ id: "oo", brand: "Nykaa Fashion", amount: 300, orderedAt: "2026-02-01T00:00:00Z" }]
    );
    // "NykaaFashion" vs "Nykaa Fashion" both slug to "nykaafashion".
    expect(r.orders[0].status).toBe("attributed");
  });
});

describe("reconcileVouchers — reconcile tolerance", () => {
  it("leftover within tolerance counts as reconciled; beyond it does not", () => {
    const nearlyEmpty = reconcileVouchers([v({ faceValue: 1000 })], [o({ amount: 999.5 })], { reconcileTolerance: 1 });
    expect(nearlyEmpty.vouchers[0].reconciled).toBe(true); // 0.5 leftover ≤ 1

    const stillHasBalance = reconcileVouchers([v({ faceValue: 1000 })], [o({ amount: 990 })], { reconcileTolerance: 1 });
    expect(stillHasBalance.vouchers[0].reconciled).toBe(false); // 10 leftover > 1
  });

  it("a small shortfall within tolerance is still 'attributed', not 'partial'", () => {
    // Voucher slightly short of the order, within rounding tolerance.
    const r = reconcileVouchers([v({ faceValue: 999.5 })], [o({ amount: 1000 })], { reconcileTolerance: 1 });
    expect(r.orders[0].status).toBe("attributed"); // 0.5 shortfall ≤ 1
  });
});

describe("reconcileVouchers — degenerate inputs", () => {
  it("empty inputs produce empty results", () => {
    expect(reconcileVouchers([], [])).toEqual({ orders: [], vouchers: [] });
  });

  it("a non-positive order amount draws nothing", () => {
    const r = reconcileVouchers([v({})], [o({ amount: 0 }), o({ id: "neg", amount: -50 })]);
    expect(r.orders.every((x) => x.draws.length === 0 && x.status === "unattributed")).toBe(true);
    expect(r.vouchers[0].drawn).toBe(0);
  });

  it("a non-positive face-value voucher is ignored (funds nothing)", () => {
    const r = reconcileVouchers([v({ faceValue: 0 }), v({ id: "neg", faceValue: -100 })], [o({ amount: 100 })]);
    expect(r.vouchers).toHaveLength(0);
    expect(r.orders[0].status).toBe("unattributed");
  });

  it("keeps paise but kills float dust across many small draws", () => {
    const r = reconcileVouchers(
      [v({ faceValue: 0.3 })],
      [o({ id: "a", amount: 0.1, orderedAt: "2026-02-01T00:00:00Z" }),
       o({ id: "b", amount: 0.2, orderedAt: "2026-02-02T00:00:00Z" })]
    );
    expect(r.vouchers[0].drawn).toBe(0.3);
    expect(r.vouchers[0].remaining).toBe(0);
  });
});
