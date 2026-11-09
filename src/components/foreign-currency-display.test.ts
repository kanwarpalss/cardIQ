import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ index: 0, slots: [] as unknown[] }));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: () => [hooks.slots[hooks.index++], () => {}],
  useEffect: () => {},
}));
import ForeignCurrencyPanel, { type ForeignTxn } from "./ForeignCurrencyPanel";

function txn(id: string, currency = "USD", historical = 8000, type: "debit" | "credit" = "debit"): ForeignTxn {
  return {
    id, card_last4: "1234", original_currency: currency, original_amount: 100,
    amount_inr: historical, merchant: "Synthetic test merchant", category: "Shopping",
    txn_at: "2026-11-01T12:00:00Z", txn_type: type,
  };
}
function render(transactions: ForeignTxn[], rates: Record<string, number | null>, asOf: string | null) {
  hooks.index = 0;
  hooks.slots = [null, false, null, {}, rates, asOf];
  const text = renderToStaticMarkup(createElement(ForeignCurrencyPanel, { transactions }))
    .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const start = text.indexOf("Difference");
  return { text, difference: start < 0 ? "" : text.slice(start) };
}
beforeEach(() => { hooks.index = 0; hooks.slots = []; });

it("does not invent a 100% reduction while rates load", () => {
  const result = render([txn("usd")], {}, null);
  expect(result.difference).toContain("Loading rates");
  expect(result.difference).not.toMatch(/[₹%]/);
});
it.each([null, 0, -85, NaN, Infinity])("keeps unavailable current rates (%s) out of totals and comparisons", rate => {
  const result = render([txn("usd")], { USD: rate }, "2026-11-09");
  expect(result.text).toContain("Unavailable");
  expect(result.text).toContain("1 unpriced");
  expect(result.difference).toContain("incomplete rates");
  expect(result.difference).not.toMatch(/[₹%]/);
  expect(result.text).not.toMatch(/NaN|Infinity/);
});
it("does not compare partial current rates against a complete historical total", () => {
  const result = render([txn("usd"), txn("eur", "EUR", 9000)], { USD: 85, EUR: null }, "2026-11-09");
  expect(result.difference).not.toMatch(/[₹%]/);
  expect(result.text).toContain("1 unpriced");
});
it("does not compare complete current rates against missing historical rates", () => {
  const result = render([txn("usd", "USD", 0)], { USD: 85 }, "2026-11-09");
  expect(result.difference).not.toMatch(/[₹%]/);
  expect(result.text).toContain("1 unpriced");
});
it("retains complete comparisons", () => {
  const result = render([txn("usd")], { USD: 85 }, "2026-11-09");
  expect(result.difference).toContain("+₹500");
  expect(result.difference).toContain("6.3%");
});
it("shows a zero rupee difference without dividing by a zero historical net", () => {
  const result = render([txn("debit"), txn("refund", "USD", 8000, "credit")], { USD: 85 }, "2026-11-09");
  expect(result.difference).toContain("+₹0");
  expect(result.difference).not.toContain("%");
  expect(result.text).not.toMatch(/NaN|Infinity/);
});
it("keeps comparison loading until rates have an as-of date", () => {
  expect(render([txn("usd")], { USD: 85 }, null).difference).not.toMatch(/[₹%]/);
});
it("renders nothing for empty transactions", () => {
  expect(render([], {}, null).text).toBe("");
});
