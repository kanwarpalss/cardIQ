// Boundary tests for order de-duplication. The footguns: don't merge two
// genuinely-different same-amount purchases (needs a TIGHT time window), and
// always keep the richest report as the primary. Each has a case that would
// fail a naive "group by amount" implementation.

import { describe, it, expect } from "vitest";
import { findDuplicateOrders, planDedup, type DedupOrder, type DedupRow } from "./order-dedup";

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

  it("the item-rich order is primary even when a poorer sibling holds the card match (Invariant #6)", () => {
    // The gateway grabbed the txn first (cross-run), but the merchant's own
    // itemized email must own the purchase — the sync then transfers the txn to
    // it. This is the exact Postbox↔Razorpay inversion this session fixes.
    const dup = findDuplicateOrders([
      o({ id: "gateway", source: "razorpay", itemsCount: 0, txn_id: "t1", order_at: "2026-07-12T10:00:00Z" }),
      o({ id: "merchant", source: "shopify", itemsCount: 3, txn_id: null, order_at: "2026-07-12T10:01:00Z" }),
    ]);
    expect(dup.get("gateway")).toBe("merchant"); // gateway is the duplicate
    expect(dup.has("merchant")).toBe(false);     // item-rich merchant is primary
  });

  it("clusters same-merchant status repeats by order_ref, regardless of time gap", () => {
    // BBW sends placed → packed → shipped → delivered over several days, each
    // repeating the ₹4181 total under the same order number. The 5-min amount
    // window can't merge them; the shared order_ref must.
    const dup = findDuplicateOrders([
      o({ id: "placed", source: "generic", itemsCount: 5, order_ref: "BBW01373248", merchantKey: "bathbodyworks", order_at: "2026-07-12T18:28:00Z" }),
      o({ id: "delivered", source: "generic", itemsCount: 1, order_ref: "BBW01373248", merchantKey: "bathbodyworks", order_at: "2026-07-16T09:00:00Z" }),
    ]);
    expect(dup.get("delivered")).toBe("placed"); // richer 'placed' is primary
    expect(dup.has("placed")).toBe(false);
  });

  it("does NOT merge different merchants that happen to share an order_ref token", () => {
    const dup = findDuplicateOrders([
      o({ id: "a", order_ref: "12345", merchantKey: "brandx", order_at: "2026-07-12T10:00:00Z" }),
      o({ id: "b", total_amount: 999, order_ref: "12345", merchantKey: "brandy", order_at: "2026-07-16T10:00:00Z" }),
    ]);
    expect(dup.size).toBe(0);
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

describe("planDedup — resolution actions", () => {
  const row = (o: Partial<DedupRow>): DedupRow => ({
    id: "x", source: "generic", itemsCount: 0, total_amount: 2897,
    order_at: "2026-07-12T10:00:00Z", txn_id: null, order_ref: "BBW1", merchantKey: "bbw",
    review_status: "unmatched", match_confidence: null, duplicate_of: null, ...o,
  });

  it("transfers the charge from an empty matched status-ping to the item-rich order (Invariant #6)", () => {
    // Real BBW shape: 'placed' has 7 items but is unmatched; 'shipped' is empty
    // but holds the confirmed card match under the same order_ref.
    const actions = planDedup([
      row({ id: "placed", itemsCount: 7, review_status: "unmatched" }),
      row({ id: "shipped", itemsCount: 0, txn_id: "t1", match_confidence: "medium", review_status: "confirmed", order_at: "2026-07-14T10:00:00Z" }),
    ]);
    const transfer = actions.find((a) => a.kind === "transfer");
    expect(transfer).toMatchObject({ primaryId: "placed", fromId: "shipped", txnId: "t1", reviewStatus: "confirmed" });
    // 'shipped' is flagged a duplicate AND releases the charge it was holding.
    expect(actions.find((a) => a.kind === "flag")).toMatchObject({ id: "shipped", primaryId: "placed", releaseTxn: true });
  });

  it("demotes a Razorpay gateway confirm in favour of the item-rich merchant order", () => {
    const actions = planDedup([
      row({ id: "merchant", source: "shopify", itemsCount: 3 }),
      row({ id: "gateway", source: "razorpay", itemsCount: 0, txn_id: "t9", review_status: "confirmed", order_ref: null, order_at: "2026-07-12T10:00:20Z" }),
    ]);
    expect(actions.find((a) => a.kind === "transfer")).toMatchObject({ primaryId: "merchant", fromId: "gateway" });
  });

  it("is idempotent — a correctly-resolved cluster yields no actions", () => {
    const actions = planDedup([
      row({ id: "placed", itemsCount: 7, txn_id: "t1", review_status: "confirmed", match_confidence: "medium" }),
      row({ id: "shipped", itemsCount: 0, review_status: "pending", duplicate_of: "placed", order_at: "2026-07-14T10:00:00Z" }),
    ]);
    expect(actions).toEqual([]);
  });
});
