// Boundary tests for order de-duplication. The footguns: don't merge two
// genuinely-different same-amount purchases (needs a TIGHT time window), and
// always keep the richest report as the primary. Each has a case that would
// fail a naive "group by amount" implementation.

import { describe, it, expect } from "vitest";
import { findDuplicateOrders, type DedupOrder } from "./order-dedup";

const o = (over: Partial<DedupOrder>): DedupOrder => ({
  id: "x", source: "generic", itemsCount: 0, total_amount: 4181,
  order_at: "2026-07-12T10:00:00Z", txn_id: null, ...over,
});

describe("findDuplicateOrders", () => {
  it("flags a gateway confirmation as a duplicate of the merchant order (same ₹, same minute)", () => {
    // Real case: "Bath and Body Works" (merchant, has items) + "Apparel Group"
    // (Razorpay gateway, no items) — one ₹4181 purchase.
    const dup = findDuplicateOrders([
      o({ id: "merchant", source: "shopify", itemsCount: 2, order_at: "2026-07-12T10:00:00Z" }),
      o({ id: "gateway", source: "razorpay", itemsCount: 0, order_at: "2026-07-12T10:00:30Z" }),
    ]);
    expect(dup.get("gateway")).toBe("merchant"); // gateway is the duplicate
    expect(dup.has("merchant")).toBe(false);     // merchant (richer) is primary
  });

  it("keeps a card-matched order as primary even if another has more items", () => {
    const dup = findDuplicateOrders([
      o({ id: "matched", itemsCount: 0, txn_id: "t1", order_at: "2026-07-12T10:00:00Z" }),
      o({ id: "rich", itemsCount: 3, txn_id: null, order_at: "2026-07-12T10:01:00Z" }),
    ]);
    expect(dup.get("rich")).toBe("matched");
  });

  it("does NOT merge two different purchases of the same amount far apart in time", () => {
    const dup = findDuplicateOrders([
      o({ id: "morning", order_at: "2026-07-12T10:00:00Z" }),
      o({ id: "evening", order_at: "2026-07-12T20:00:00Z" }),
    ]);
    expect(dup.size).toBe(0);
  });

  it("does NOT merge same-time orders of DIFFERENT amounts", () => {
    const dup = findDuplicateOrders([
      o({ id: "a", total_amount: 4181, order_at: "2026-07-12T10:00:00Z" }),
      o({ id: "b", total_amount: 999, order_at: "2026-07-12T10:00:10Z" }),
    ]);
    expect(dup.size).toBe(0);
  });

  it("collapses a 3-way cluster (merchant + gateway + shipper) to one primary", () => {
    const dup = findDuplicateOrders([
      o({ id: "merchant", source: "shopify", itemsCount: 1, order_at: "2026-07-12T10:00:00Z" }),
      o({ id: "gateway", source: "razorpay", order_at: "2026-07-12T10:00:20Z" }),
      o({ id: "shipper", source: "generic", order_at: "2026-07-12T10:02:00Z" }),
    ]);
    expect(dup.get("gateway")).toBe("merchant");
    expect(dup.get("shipper")).toBe("merchant");
    expect(dup.size).toBe(2);
  });

  it("tolerates paise rounding within ₹0.75", () => {
    const dup = findDuplicateOrders([
      o({ id: "a", source: "shopify", itemsCount: 1, total_amount: 4181.0, order_at: "2026-07-12T10:00:00Z" }),
      o({ id: "b", source: "razorpay", total_amount: 4181.5, order_at: "2026-07-12T10:00:05Z" }),
    ]);
    expect(dup.get("b")).toBe("a");
  });

  it("is deterministic regardless of input order", () => {
    const a = o({ id: "merchant", source: "shopify", itemsCount: 2, order_at: "2026-07-12T10:00:00Z" });
    const b = o({ id: "gateway", source: "razorpay", order_at: "2026-07-12T10:00:30Z" });
    expect(findDuplicateOrders([a, b])).toEqual(findDuplicateOrders([b, a]));
  });

  it("ignores amount-less orders (can't be compared)", () => {
    const dup = findDuplicateOrders([
      o({ id: "a", total_amount: null, order_at: "2026-07-12T10:00:00Z" }),
      o({ id: "b", total_amount: null, order_at: "2026-07-12T10:00:10Z" }),
    ]);
    expect(dup.size).toBe(0);
  });
});
