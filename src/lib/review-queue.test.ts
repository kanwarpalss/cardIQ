import { describe, expect, it } from "vitest";
import { ordersWithValidReviewCharge, type ReviewQueueOrder, type ReviewQueueTxn } from "./review-queue";

const order = (over: Partial<ReviewQueueOrder> = {}): ReviewQueueOrder => ({
  id: "order-1",
  txn_id: "txn-1",
  kind: "order",
  total_amount: 365,
  order_at: "2026-07-06T05:20:00Z",
  ...over,
});
const txn = (over: Partial<ReviewQueueTxn> = {}): ReviewQueueTxn => ({
  id: "txn-1",
  user_id: "user-1",
  amount_inr: 365,
  txn_at: "2026-07-06T05:30:00Z",
  txn_type: "debit",
  ...over,
});

describe("ordersWithValidReviewCharge", () => {
  it("keeps a genuine order-to-card-charge pair", () => {
    expect(ordersWithValidReviewCharge([order()], [txn()], "user-1")).toEqual([order()]);
  });

  it("drops an order with no proposed card charge", () => {
    expect(ordersWithValidReviewCharge([order({ txn_id: null })], [txn()], "user-1")).toEqual([]);
  });

  it("drops an order whose referenced charge no longer exists", () => {
    expect(ordersWithValidReviewCharge([order({ txn_id: "deleted-charge" })], [txn()], "user-1")).toEqual([]);
  });

  it("never shows another user's card charge as a pair", () => {
    expect(ordersWithValidReviewCharge([order()], [txn({ user_id: "user-2" })], "user-1")).toEqual([]);
  });

  it("drops an amount-less Amazon-style delivery notice even if a charge is linked", () => {
    expect(ordersWithValidReviewCharge([order({ total_amount: null })], [txn()], "user-1")).toEqual([]);
  });

  it("drops amount, date, and debit/credit mismatches from historic links", () => {
    expect(ordersWithValidReviewCharge([order()], [txn({ amount_inr: 999 })], "user-1")).toEqual([]);
    expect(ordersWithValidReviewCharge([order()], [txn({ txn_at: "2026-07-12T05:20:00Z" })], "user-1")).toEqual([]);
    expect(ordersWithValidReviewCharge([order()], [txn({ txn_type: "credit" })], "user-1")).toEqual([]);
  });

  it("uses a positive direct-card portion for split-payment reviews", () => {
    const split = order({ total_amount: 5_793, card_paid_amount: 793 });
    expect(ordersWithValidReviewCharge([split], [txn({ amount_inr: 793 })], "user-1")).toEqual([split]);
    expect(ordersWithValidReviewCharge([split], [txn({ amount_inr: 5_793 })], "user-1")).toEqual([]);
  });

  it("rejects malformed runtime values rather than coercing them into a pair", () => {
    expect(ordersWithValidReviewCharge(
      [order({ total_amount: "" as unknown as number })],
      [txn()],
      "user-1"
    )).toEqual([]);
    expect(ordersWithValidReviewCharge(
      [order()],
      [txn({ amount_inr: "365" as unknown as number })],
      "user-1"
    )).toEqual([]);
  });

  it("does not let a valid pair make an adjacent broken entry appear", () => {
    const orders = [order({ id: "good" }), order({ id: "empty", txn_id: null }), order({ id: "stale", txn_id: "gone" })];
    expect(ordersWithValidReviewCharge(orders, [txn()], "user-1").map((row) => row.id)).toEqual(["good"]);
  });

  it("suppresses two orders that both claim the same charge", () => {
    expect(ordersWithValidReviewCharge(
      [order({ id: "first" }), order({ id: "second" })],
      [txn()],
      "user-1"
    )).toEqual([]);
  });
});
