import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AppNavigation, { TABS } from "./AppNavigation";
import SpendFilterPanel from "./SpendFilterPanel";

function renderNav(reviewCount = 0, expiringCount = 0) {
  return renderToStaticMarkup(createElement(AppNavigation, {
    tab: "Overview", onNavigate: () => {}, onSignOut: () => {}, reviewCount, expiringCount,
  }));
}
describe("phone navigation", () => {
  it("keeps four primary destinations visible and every other destination in More", () => {
    const html = renderNav();
    const primary = html.split('aria-label="Phone navigation"')[1].split("</nav>")[0];
    const more = html.split('aria-label="More sections"')[1].split("</nav>")[0];
    expect(primary.match(/<button/g)).toHaveLength(5);
    for (const label of ["Home", "Spend", "Rewards", "Cards", "More"]) expect(primary).toContain(`>${label}</span>`);
    for (const label of TABS.filter(tab => !["Overview", "Spend", "Redemptions", "Cards"].includes(tab))) {
      expect(more).toContain(`<strong>${label}</strong>`);
    }
    expect(html).toContain('aria-labelledby="more-title"');
    expect(html).toContain('aria-label="Close more sections"');
  });
  it("keeps badges quiet for zero counts", () => {
    expect(renderNav()).not.toContain('class="nav-badge"');
  });
  it.each([1, 99, 100, 1000])("preserves the exact accessible count for %s notices", count => {
    const html = renderNav(count, count);
    expect(html).toContain(`${count} matches awaiting review`);
    expect(html).toContain(`${count} holdings expiring in the next 30 days`);
    expect(html).toContain(`>${count > 99 ? "99+" : count}</span>`);
  });
});
it.each([null, "Minimum amount must be less than the maximum"])("discloses active constraints and errors while phone controls are folded away (%s)", amountError => {
  const noop = () => {};
  const html = renderToStaticMarkup(createElement(SpendFilterPanel, {
    search: "", onSearchChange: noop, from: "", to: "", onPeriodChange: noop,
    merchant: "A long merchant", merchants: ["A long merchant"], onMerchantChange: noop,
    category: "Shopping", categories: ["Shopping"], onCategoryChange: noop,
    subcategory: null, subcategories: [], onSubcategoryChange: noop,
    amountMin: "100", amountMax: "", onAmountMinChange: noop, onAmountMaxChange: noop,
    amountError, selectedCards: new Set(["1234"]), cards: [], onToggleCard: noop,
    txnType: "credit", onTxnTypeChange: noop, resultCount: 0, onReset: noop,
  }));
  expect(html).toContain("Filters · 5 active");
  expect(html).toContain('aria-expanded="false" aria-controls="spend-refinements"');
  expect(html).toContain('id="spend-refinements" class="hidden md:grid');
  expect(html).toContain("Reset all");
  if (amountError) expect(html).toContain(`role="alert">${amountError}</p>`);
});
