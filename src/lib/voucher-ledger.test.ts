// Boundary tests for the voucher-ledger summary. It sums MONEY drawn from a
// balance — so the cruel cases are over-draw, float dust, refunds, orphan
// draws and junk amounts. Each would fail a naive faceValue - sum(amount).

import { describe, it, expect } from "vitest";
import { summarizeVoucherLedger, type LedgerVoucher, type LedgerOrder } from "./voucher-ledger";

const v = (id: string, faceValue: number): LedgerVoucher => ({ id, faceValue });
const order = (id: string, merchant: string, orderAt: string, draws: Array<[string, number]>): LedgerOrder => ({
  id, merchant, orderAt, draws: draws.map(([voucherId, amount]) => ({ voucherId, amount })),
});

describe("summarizeVoucherLedger", () => {
  it("basic single draw: drawn + remaining + one spend", () => {
    const out = summarizeVoucherLedger([v("A", 2000)], [order("o1", "Amazon", "2026-01-01", [["A", 500]])]);
    const a = out.get("A")!;
    expect(a.drawn).toBe(500);
    expect(a.remaining).toBe(1500);
    expect(a.spends).toEqual([{ orderId: "o1", merchant: "Amazon", amount: 500, orderAt: "2026-01-01" }]);
  });

  it("multiple orders drain the same voucher (summed, both recorded)", () => {
    const out = summarizeVoucherLedger(
      [v("A", 2000)],
      [order("o1", "Amazon", "2026-01-01", [["A", 500]]), order("o2", "Amazon", "2026-01-05", [["A", 700]])]
    );
    const a = out.get("A")!;
    expect(a.drawn).toBe(1200);
    expect(a.remaining).toBe(800);
    expect(a.spends.map((s) => s.orderId)).toEqual(["o1", "o2"]);
  });

  it("untouched voucher reads full: drawn 0, remaining = faceValue, no spends", () => {
    const out = summarizeVoucherLedger([v("A", 2000)], []);
    expect(out.get("A")).toEqual({ drawn: 0, remaining: 2000, spends: [] });
  });

  it("draw referencing an unknown voucher is ignored (not counted, no crash)", () => {
    const out = summarizeVoucherLedger([v("A", 2000)], [order("o1", "Amazon", "2026-01-01", [["GHOST", 999]])]);
    expect(out.get("A")!.drawn).toBe(0);
    expect(out.has("GHOST")).toBe(false);
  });

  it("over-draw is clamped: remaining never goes negative", () => {
    const out = summarizeVoucherLedger([v("A", 1000)], [order("o1", "Amazon", "2026-01-01", [["A", 1500]])]);
    const a = out.get("A")!;
    expect(a.drawn).toBe(1500);
    expect(a.remaining).toBe(0); // NOT -500
  });

  it("float dust is rounded to paise (0.1 + 0.2 drift killed)", () => {
    const out = summarizeVoucherLedger(
      [v("A", 1)],
      [order("o1", "x", "2026-01-01", [["A", 0.1]]), order("o2", "x", "2026-01-02", [["A", 0.2]])]
    );
    const a = out.get("A")!;
    expect(a.drawn).toBe(0.3);       // not 0.30000000000000004
    expect(a.remaining).toBe(0.7);
  });

  it("zero-amount and non-finite draws are skipped", () => {
    const out = summarizeVoucherLedger(
      [v("A", 1000)],
      [order("o1", "x", "2026-01-01", [["A", 0], ["A", NaN], ["A", Infinity], ["A", 200]])]
    );
    const a = out.get("A")!;
    expect(a.drawn).toBe(200);
    expect(a.spends).toHaveLength(1);
  });

  it("a refund (negative draw) never inflates remaining above face value", () => {
    const out = summarizeVoucherLedger([v("A", 1000)], [order("o1", "x", "2026-01-01", [["A", -300]])]);
    const a = out.get("A")!;
    expect(a.drawn).toBe(-300);
    expect(a.remaining).toBe(1000); // clamped to face, NOT 1300
  });

  it("spends are ordered oldest-first regardless of input order", () => {
    const out = summarizeVoucherLedger(
      [v("A", 5000)],
      [order("late", "x", "2026-03-01", [["A", 100]]), order("early", "x", "2026-01-01", [["A", 100]])]
    );
    expect(out.get("A")!.spends.map((s) => s.orderId)).toEqual(["early", "late"]);
  });

  it("one order drawing from two vouchers splits correctly", () => {
    const out = summarizeVoucherLedger(
      [v("A", 1000), v("B", 1000)],
      [order("o1", "Amazon", "2026-01-01", [["A", 1000], ["B", 250]])]
    );
    expect(out.get("A")!.remaining).toBe(0);
    expect(out.get("B")!.remaining).toBe(750);
  });

  it("empty inputs produce an empty map", () => {
    expect(summarizeVoucherLedger([], []).size).toBe(0);
  });
});
