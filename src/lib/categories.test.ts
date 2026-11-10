import { describe, expect, it } from "vitest";
import { CATEGORIES, REGROUP_MOVES, SUBCATEGORIES, regroupPair } from "./categories";
import { CATEGORY_RULES, categorizeFull } from "./categorize";

const OLD_ONLY = ["Fuel", "Utilities", "Rent", "CRED Payments", "Vouchers", "Rewards", "Sports & Recreation"];
const isDefaultPair = (category: string, sub: string | null) =>
  (CATEGORIES as readonly string[]).includes(category) &&
  (sub === null || (SUBCATEGORIES as Record<string, readonly string[]>)[category].includes(sub));

describe("2026-11-10 regroup defaults", () => {
  it("has 14 groups and none of the retired names", () => {
    expect(CATEGORIES).toHaveLength(14);
    for (const old of OLD_ONLY) expect(CATEGORIES).not.toContain(old);
    expect(CATEGORIES.at(-1)).toBe("Uncategorized");
  });

  it("every keyword rule emits a default category + subcategory (no orphan names)", () => {
    const bad = CATEGORY_RULES.filter((r) => !isDefaultPair(r.category, r.subcategory ?? null));
    expect(bad).toEqual([]);
  });

  it("every regroup destination exists in the defaults; every source is retired or a moved subcategory", () => {
    for (const m of REGROUP_MOVES) {
      expect(isDefaultPair(m.to.category, m.to.subcategory ?? null)).toBe(true);
      const sourceStillDefault = (CATEGORIES as readonly string[]).includes(m.from.category);
      if (sourceStillDefault) expect(m.from.subcategory).toBeDefined(); // e.g. Financial · Jewellery
    }
  });

  // What the PRE-regroup rules returned for real-world merchant strings.
  // Moving that old answer with regroupPair() must land exactly where the NEW
  // rules put the same merchant — otherwise the data script and fresh syncs
  // would disagree and the same merchant would show up in two places.
  const OLD_ANSWERS: Array<[merchant: string, category: string, sub: string | null]> = [
    ["HPCL PETROL PUMP", "Fuel", null],
    ["Shell Select", "Fuel", null],
    ["AIRTEL FASTAG RECHARGE", "Utilities", null],
    ["Paytm Fastag", "Utilities", null],
    ["Airtel Postpaid", "Utilities", null],
    ["BESCOM Electricity", "Utilities", null],
    ["Tata Sky DTH", "Utilities", null],
    ["NoBroker Rent Payment", "Rent", null],
    ["CRED Club", "CRED Payments", null],
    ["Malabar Gold", "Financial", "Jewellery"],
    ["Gyftr Voucher", "Vouchers", null],
    ["ICICI Reward Points", "Rewards", null],
    ["Huddle Pickleball", "Sports & Recreation", "Pickleball"],
    ["Padel Club", "Sports & Recreation", "Padel"],
    ["Playo", "Sports & Recreation", null],
    ["LIC Insurance", "Financial", "Insurance"],
    ["Bajaj EMI", "Financial", null],
    ["Swiggy Instamart", "Groceries", "Quick Commerce"],
    ["Starbucks", "Dining", "Coffee"],
    ["Uber", "Transport", "Cabs"],
  ];

  it.each(OLD_ANSWERS)("%s: old answer moved by the regroup == new rules", (merchant, category, sub) => {
    expect(regroupPair({ category, subcategory: sub, merchant })).toEqual(categorizeFull(merchant));
  });

  it("keeps a row's own subcategory when the move doesn't name one", () => {
    expect(regroupPair({ category: "Utilities", subcategory: "DTH", merchant: "x" })).toEqual({ category: "Home & Bills", subcategory: "DTH" });
    expect(regroupPair({ category: "Vouchers", subcategory: "Gift Cards", merchant: "x" })).toEqual({ category: "Vouchers & Rewards", subcategory: "Gift Cards" });
  });

  it("leaves untouched categories (and custom ones) alone", () => {
    expect(regroupPair({ category: "Dining", subcategory: "Coffee" })).toEqual({ category: "Dining", subcategory: "Coffee" });
    expect(regroupPair({ category: "Financial", subcategory: "Insurance" })).toEqual({ category: "Financial", subcategory: "Insurance" });
    expect(regroupPair({ category: "Gifts", subcategory: null })).toEqual({ category: "Gifts", subcategory: null });
    expect(regroupPair({ category: null })).toEqual({ category: null, subcategory: null });
  });

  it("is idempotent — running the regroup twice changes nothing more", () => {
    for (const [merchant, category, sub] of OLD_ANSWERS) {
      const once = regroupPair({ category, subcategory: sub, merchant });
      expect(regroupPair({ ...once, merchant })).toEqual(once);
    }
  });
});
