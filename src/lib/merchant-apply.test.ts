import { describe, expect, it } from "vitest";
import { applyCandidates, defaultRemember, defaultSelection, selectedTotal, type ApplyTxn } from "./merchant-apply";

const t = (id: string, over: Partial<ApplyTxn> = {}): ApplyTxn => ({
  id, merchant: "Starbucks", category: "Dining", subcategory: null, txn_at: `2026-10-${id.padStart(2, "0")}T10:00:00Z`,
  amount_inr: 100, txn_type: "debit", ...over,
});
const coffee = { category: "Dining", subcategory: "Coffee" };

describe("applyCandidates", () => {
  it("lists the other same-merchant rows newest first, excluding the source and exact matches", () => {
    const all = [t("1"), t("2"), t("3", { subcategory: "Coffee" }), t("4", { merchant: "Starbucks Reserve" }), t("5")];
    const { candidates, alreadyThere } = applyCandidates(all, all[0], coffee);
    expect(candidates.map((x) => x.id)).toEqual(["5", "2"]);
    expect(alreadyThere).toBe(1);
  });

  it("treats a missing category as Uncategorized and a missing subcategory as none", () => {
    const all = [t("1"), t("2", { category: null, subcategory: undefined })];
    expect(applyCandidates(all, all[0], { category: "Uncategorized", subcategory: null }).alreadyThere).toBe(1);
  });

  it("returns nothing for a transaction with no merchant", () => {
    const all = [t("1", { merchant: null }), t("2", { merchant: null })];
    expect(applyCandidates(all, all[0], coffee)).toEqual({ candidates: [], alreadyThere: 0 });
  });
});

describe("defaults", () => {
  it("leaves hand-picked rows unticked", () => {
    const c = [t("1"), t("2", { category_manual: true }), t("3", { category_manual: null })];
    expect([...defaultSelection(c)]).toEqual(["1", "3"]);
  });

  it("suggests remembering only when everything listed is ticked", () => {
    const c = [t("1"), t("2")];
    expect(defaultRemember(c, new Set(["1", "2"]))).toBe(true);
    expect(defaultRemember(c, new Set(["1"]))).toBe(false);
    expect(defaultRemember([], new Set())).toBe(true);
  });

  it("totals ticked rows with refunds netted off", () => {
    const c = [t("1", { amount_inr: 500 }), t("2", { amount_inr: 120, txn_type: "credit" }), t("3", { amount_inr: 999 })];
    expect(selectedTotal(c, new Set(["1", "2"]))).toBe(380);
  });
});
