import { describe, expect, it } from "vitest";
import {
  buildSpendSearchContext,
  filterSpendTransactions,
  summarizeSpendTransactions,
  type SpendFilterTxn,
} from "./spend-filter";

type Row = SpendFilterTxn & { id: string };
const txn = (overrides: Partial<Row> = {}): Row => ({
  id: "wanted",
  card_last4: "1111",
  amount_inr: 1_234.56,
  merchant: "Amazon",
  txn_at: "2026-04-01T12:00:00+05:30",
  txn_type: "debit",
  category: "Groceries",
  subcategory: "Supermarket",
  notes: "House supplies",
  ...overrides,
});
const filters = {
  from: "2026-04-01",
  to: "2026-04-30",
  selectedCards: new Set(["all"]),
  txnType: "all" as const,
  category: null,
  subcategory: null,
  merchant: null,
  search: "",
  amountMin: null,
  amountMax: null,
};

describe("filterSpendTransactions", () => {
  it("includes local start midnight and the final millisecond, but not the next day", () => {
    const rows = filterSpendTransactions([
      txn({ id: "start", txn_at: "2026-04-01T00:00:00+05:30" }),
      txn({ id: "last", txn_at: "2026-04-30T23:59:59.999+05:30" }),
      txn({ id: "next", txn_at: "2026-05-01T00:00:00+05:30" }),
    ], filters);
    expect(rows.map((row) => row.id)).toEqual(["start", "last"]);
  });

  it("ANDs card, type, and category filters", () => {
    const rows = filterSpendTransactions([
      txn(),
      txn({ id: "wrong-card", card_last4: "2222" }),
      txn({ id: "credit", txn_type: "credit" }),
      txn({ id: "dining", category: "Dining" }),
      txn({ id: "coffee", subcategory: "Coffee" }),
      txn({ id: "other-merchant", merchant: "Blinkit" }),
    ], {
      ...filters,
      selectedCards: new Set(["1111"]),
      txnType: "debit",
      category: "Groceries",
      subcategory: "Supermarket",
      merchant: "Amazon",
    });
    expect(rows.map((row) => row.id)).toEqual(["wanted"]);
  });

  it("rejects invalid timestamps and invalid or reversed date ranges", () => {
    expect(filterSpendTransactions([txn({ txn_at: "not-a-date" })], filters)).toEqual([]);
    expect(filterSpendTransactions([txn()], { ...filters, from: "2026-04-31" })).toEqual([]);
    expect(filterSpendTransactions([txn()], { ...filters, from: "2026-05-01" })).toEqual([]);
  });

  it("treats an empty selected-card set as no selected cards, not all cards", () => {
    expect(filterSpendTransactions([txn()], { ...filters, selectedCards: new Set() })).toEqual([]);
  });

  it("searches merchant, category, notes, card, amount, and enriched spend details", () => {
    const context = buildSpendSearchContext(
      [txn()],
      [{ last4: "1111", label: "HDFC Infinia" }],
      new Map([["wanted", {
        source: "Amazon",
        order_ref: "402-111",
        merchant_name: "Paws & Co",
        total_amount: 1_234.56,
        items: [{ name: "Pickleball paddle", qty: 1, price: 1_234.56 }],
      }]]),
      new Map([["wanted", [{ brand: "Gyftr Luxe", face_value: 1_500 }]]]),
    );
    for (const search of [
      "AMAZON",
      "groceries supermarket",
      "house supplies",
      "1111",
      "1234.56",
      "1,234.56",
      "₹1,235",
      "hdfc pickleball",
      "paws",
      "402-111",
      "gyftr luxe",
    ]) {
      expect(
        filterSpendTransactions([txn()], { ...filters, search, searchContext: context }).map((row) => row.id)
      ).toEqual(["wanted"]);
    }
  });

  it("normalizes whitespace and Latin accents, preserves Unicode, and treats regex characters literally", () => {
    const rows = [
      txn({ id: "unicode", merchant: "Café दिल्ली", notes: "ACME.*SHOP" }),
      txn({ id: "other", merchant: "Anything Else" }),
    ];
    expect(filterSpendTransactions(rows, { ...filters, search: "  CAFE   दिल्ली " }).map((row) => row.id))
      .toEqual(["unicode"]);
    expect(filterSpendTransactions(rows, { ...filters, search: ".*" }).map((row) => row.id))
      .toEqual(["unicode"]);
    expect(filterSpendTransactions(rows, { ...filters, search: "[" })).toEqual([]);
  });

  it("applies inclusive amount limits and fails closed for invalid money", () => {
    const rows = [
      txn({ id: "zero", amount_inr: 0 }),
      txn({ id: "decimal", amount_inr: 99.99 }),
      txn({ id: "maximum", amount_inr: 100 }),
      txn({ id: "negative", amount_inr: -1 }),
      txn({ id: "nan", amount_inr: Number.NaN }),
      txn({ id: "infinity", amount_inr: Number.POSITIVE_INFINITY }),
    ];
    expect(filterSpendTransactions(rows, { ...filters, amountMin: 0, amountMax: 99.99 }).map((row) => row.id))
      .toEqual(["zero", "decimal"]);
    expect(filterSpendTransactions(rows, { ...filters, amountMin: 101, amountMax: 100 })).toEqual([]);
    expect(filterSpendTransactions(rows, { ...filters, amountMin: Number.NaN })).toEqual([]);
    expect(filterSpendTransactions(rows, { ...filters, amountMax: Number.POSITIVE_INFINITY })).toEqual([]);
    expect(filterSpendTransactions(rows, { ...filters, amountMin: -1 })).toEqual([]);
  });

  it("matches Uncategorized and missing merchant by their displayed labels", () => {
    const missing = txn({ merchant: null, category: null });
    expect(filterSpendTransactions([missing], { ...filters, category: "Uncategorized" })).toEqual([missing]);
    expect(filterSpendTransactions([missing], { ...filters, merchant: "(missing)" })).toEqual([missing]);
    expect(filterSpendTransactions([missing], { ...filters, search: "uncategorized" })).toEqual([missing]);
  });

  it("uses exact equality for merchant, category, and subcategory dropdowns", () => {
    const rows = [
      txn({ id: "exact", merchant: "Amazon", category: "Dining", subcategory: "Coffee" }),
      txn({ id: "merchant-prefix", merchant: "Amazon Fresh", category: "Dining", subcategory: "Coffee" }),
      txn({ id: "category-prefix", merchant: "Amazon", category: "Dining Out", subcategory: "Coffee" }),
    ];
    expect(filterSpendTransactions(rows, {
      ...filters,
      merchant: "Amazon",
      category: "Dining",
      subcategory: "Coffee",
    }).map((row) => row.id)).toEqual(["exact"]);
  });

  it("excludes ambiguous offset-less timestamps and locks rolling date boundaries", () => {
    expect(filterSpendTransactions([
      txn({ id: "start-30d", txn_at: "2026-06-29T00:00:00+05:30" }),
      txn({ id: "before-30d", txn_at: "2026-06-28T23:59:59.999+05:30" }),
      txn({ id: "end", txn_at: "2026-07-28T23:59:59.999+05:30" }),
      txn({ id: "ambiguous", txn_at: "2026-07-01T12:00:00" }),
    ], {
      ...filters,
      from: "2026-06-29",
      to: "2026-07-28",
    }).map((row) => row.id)).toEqual(["start-30d", "end"]);

    expect(filterSpendTransactions([
      txn({ id: "year-start", txn_at: "2025-07-28T00:00:00+05:30" }),
      txn({ id: "year-before", txn_at: "2025-07-27T23:59:59.999+05:30" }),
      txn({ id: "year-end", txn_at: "2026-07-28T23:59:59.999+05:30" }),
    ], {
      ...filters,
      from: "2025-07-28",
      to: "2026-07-28",
    }).map((row) => row.id)).toEqual(["year-start", "year-end"]);
  });

  it("feeds totals and breakdowns from the exact same searched result set — foreign txns fold in at their stored INR-on-txn-date amount (2026-10-26)", () => {
    const visible = filterSpendTransactions([
      txn({ id: "spend", amount_inr: 100, merchant: "Huddle", notes: "Pickleball" }),
      txn({ id: "refund", amount_inr: 20, merchant: "Huddle", notes: "Pickleball", txn_type: "credit" }),
      txn({ id: "foreign", amount_inr: 50, merchant: "Huddle", notes: "Pickleball", original_currency: "USD" }),
      txn({ id: "unrelated", amount_inr: 1_000, merchant: "Amazon", notes: null }),
    ], { ...filters, search: "pickleball" });

    const result = summarizeSpendTransactions(visible);
    expect(visible.map((row) => row.id)).toEqual(["spend", "refund", "foreign"]);
    // inrTxns/foreignTxns still split — now only to feed the supplemental
    // Foreign Currency panel, not to gate what counts toward totals below.
    expect(result.inrTxns.map((row) => row.id)).toEqual(["spend", "refund"]);
    expect(result.foreignTxns.map((row) => row.id)).toEqual(["foreign"]);
    expect(result.summary).toEqual({
      total_debit: 150, // 100 (INR) + 50 (foreign, at its stored historical rate)
      total_credit: 20,
      net: 130,
      txn_count: 3,
      debit_count: 2,
      credit_count: 1,
    });
    expect(result.by_merchant).toEqual([{
      merchant: "Huddle",
      total: 150,
      count: 2,
      category: "Groceries",
      subcategory: "Supermarket",
    }]);
    expect(result.by_category).toEqual([{ category: "Groceries", total: 150, count: 2 }]);
  });
});

describe("summarizeSpendTransactions — foreign currency fold-in (2026-10-26)", () => {
  it("sums a foreign debit into a merchant's total instead of silently halving it", () => {
    const result = summarizeSpendTransactions([
      txn({ id: "inr", merchant: "Huddle", amount_inr: 1000, original_currency: null }),
      txn({ id: "fx", merchant: "Huddle", amount_inr: 500, original_currency: "USD" }),
    ]);
    expect(result.by_merchant).toEqual([
      { merchant: "Huddle", total: 1500, count: 2, category: "Groceries", subcategory: "Supermarket" },
    ]);
  });

  it("does not erase a merchant whose only spend is foreign", () => {
    const result = summarizeSpendTransactions([
      txn({ id: "solo-fx", merchant: "Duty Free Dubai", category: "Travel", amount_inr: 8000, original_currency: "AED" }),
    ]);
    expect(result.by_merchant).toEqual([
      { merchant: "Duty Free Dubai", total: 8000, count: 1, category: "Travel", subcategory: "Supermarket" },
    ]);
    expect(result.by_category).toEqual([{ category: "Travel", total: 8000, count: 1 }]);
  });

  it("fails closed on a corrupted amount_inr (negative or NaN) instead of letting it poison the page total", () => {
    const negative = summarizeSpendTransactions([
      txn({ id: "good", amount_inr: 1000, original_currency: null }),
      txn({ id: "bad-negative", amount_inr: -500, original_currency: "USD" }),
    ]);
    expect(negative.summary.total_debit).toBe(1000);
    expect(negative.summary.debit_count).toBe(1);

    const nanned = summarizeSpendTransactions([
      txn({ id: "good2", amount_inr: 1000, original_currency: null }),
      txn({ id: "bad-nan", amount_inr: Number.NaN, original_currency: "USD" }),
    ]);
    expect(nanned.summary.total_debit).toBe(1000);
    expect(nanned.summary.debit_count).toBe(1);
  });

  it("includes a ₹0 'FX rate fetch failed' sentinel with zero contribution but a visible count", () => {
    const result = summarizeSpendTransactions([
      txn({ id: "fx-zero", merchant: "Flights Intl", amount_inr: 0, original_amount: 75, original_currency: "USD" }),
    ]);
    expect(result.summary).toMatchObject({ total_debit: 0, debit_count: 1, txn_count: 1 });
    expect(result.by_merchant).toEqual([
      { merchant: "Flights Intl", total: 0, count: 1, category: "Groceries", subcategory: "Supermarket" },
    ]);
  });

  it("folds every currency-code shape into totals uniformly; classification (inrTxns/foreignTxns split) is unaffected", () => {
    const rows = [
      txn({ id: "undef", merchant: "X", amount_inr: 200 }), // original_currency omitted
      txn({ id: "null", merchant: "X", amount_inr: 300, original_currency: null }),
      txn({ id: "empty", merchant: "X", amount_inr: 50, original_currency: "" }),
      txn({ id: "padded-lower", merchant: "X", amount_inr: 500, original_currency: " usd " }),
      txn({ id: "explicit-inr", merchant: "X", amount_inr: 40, original_amount: 999, original_currency: "INR", txn_type: "credit" }),
      txn({ id: "fx-refund", merchant: "X", amount_inr: 120, original_currency: "EUR", txn_type: "credit" }),
    ];
    const result = summarizeSpendTransactions(rows);
    expect(result.inrTxns.map((r) => r.id)).toEqual(["undef", "null", "empty", "explicit-inr"]);
    expect(result.foreignTxns.map((r) => r.id)).toEqual(["padded-lower", "fx-refund"]);
    expect(result.summary).toEqual({
      total_debit: 1050, total_credit: 160, net: 890,
      txn_count: 6, debit_count: 4, credit_count: 2,
    });
    expect(result.by_merchant).toEqual([
      { merchant: "X", total: 1050, count: 4, category: "Groceries", subcategory: "Supermarket" },
    ]);
  });
});
