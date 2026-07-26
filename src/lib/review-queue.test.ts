import { describe, expect, it } from "vitest";
import { ordersWithValidReviewCharge } from "./review-queue";

const order = (over: Partial<{ id: string; txn_id: string | null }> = {}) => ({
  id: "order-1", txn_id: "txn-1", ...over,
});
const txn = (over: Partial<{ id: string; user_id: string }> = {}) => ({
  id: "txn-1", user_id: "user-1", ...over,
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

  it("does not let a valid pair make an adjacent broken entry appear", () => {
    const orders = [order({ id: "good" }), order({ id: "empty", txn_id: null }), order({ id: "stale", txn_id: "gone" })];
    expect(ordersWithValidReviewCharge(orders, [txn()], "user-1").map((row) => row.id)).toEqual(["good"]);
  });
});
