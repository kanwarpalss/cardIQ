import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import TransferSearch from "./TransferSearch";
import { buildWallet } from "./transfer-ui";
import { dedupKey } from "@/lib/deals/score";
import { EMPTY_SELECTION, type Selection } from "@/lib/transfer-partners/search";
import type { RedemptionsData } from "@/lib/redemptions-data";
import type { StoredDeal } from "@/lib/deals/types";

// KP's real cards and the balances his statements and program emails stated
// (Oct–Nov 2026). The HDFC → Marriott transfer bonus is a FIXTURE, to read
// the boosted-number line; the Marriott points sale is real.
const NOW = Date.parse("2026-11-10T06:30:00Z");
const DATA = {
  cards: [
    { id: "a1", last4: "4455", nickname: null, product_key: "axis_magnus_burgundy" },
    { id: "a2", last4: "2294", nickname: null, product_key: "axis_magnus_burgundy" },
    { id: "h1", last4: "5906", nickname: null, product_key: "hdfc_infinia" },
    { id: "s1", last4: "3034", nickname: null, product_key: "hdfc_swiggy" },
    { id: "p1", last4: "4502", nickname: null, product_key: "hsbc_premier" },
  ],
  rewards: [
    { id: "r1", card_id: "a1", program: "EDGE", balance: 765241, as_of: "2026-10-15", points_expire_on: null, notes: "From statement: Axis Oct", created_at: "2026-11-10" },
    { id: "r2", card_id: "a2", program: "EDGE", balance: 62328, as_of: "2026-10-15", points_expire_on: null, notes: "From statement: Axis Oct", created_at: "2026-11-10" },
    { id: "r3", card_id: "h1", program: "RP", balance: 226113, as_of: "2026-10-15", points_expire_on: null, notes: "From statement: HDFC Oct", created_at: "2026-11-10" },
  ],
  loyalty: [
    { id: "l1", program_name: "Marriott Bonvoy", program_type: "hotel", points_balance: 225991, updated_at: "2026-08-15T04:55:31Z", source: "manual" },
    { id: "l2", program_name: "Hilton Honors", program_type: "hotel", points_balance: 21315, updated_at: "2026-11-03T23:59:59Z", source: "parsed" },
    { id: "l3", program_name: "KrisFlyer Singapore Airlines", program_type: "airline", points_balance: 31485, updated_at: "2026-10-01T23:59:59Z", source: "parsed" },
  ],
  vouchers: [], expiring: [], perksTableMissing: false, vouchersTableMissing: false, expiryColumnMissing: false, error: null,
} as unknown as RedemptionsData;

const deal = (over: Partial<StoredDeal>): StoredDeal => {
  const d = {
    id: over.headline ?? "d", dedup_key: "", kind: "buy_points", program: "marriott", from_bank: null, from_program: null,
    from_other: null, bonus_pct: null, discount_pct: null, starts_on: null, ends_on: null, targeted: false, headline: "",
    evidence: "", evidence_verified: true, sources: [], first_seen_at: "2026-10-14T00:00:00Z", last_seen_at: "2026-11-04T00:00:00Z",
    ...over,
  } as StoredDeal;
  return { ...d, dedup_key: dedupKey(d) };
};
const DEALS = [
  deal({ headline: "Marriott Bonvoy: up to 55% bonus on bought points", bonus_pct: 55, ends_on: "2026-11-23" }),
  deal({ kind: "transfer_bonus", headline: "HDFC to Marriott: 20% bonus", from_bank: "hdfc", bonus_pct: 20, ends_on: "2026-11-30" }),
  deal({ headline: "Old Marriott sale", bonus_pct: 40, ends_on: "2026-03-26" }),
];

const render = (initial: Selection) => renderToStaticMarkup(createElement(TransferSearch, {
  data: DATA, wallet: buildWallet(DATA), initial, now: NOW,
  initialDeals: { deals: DEALS, runs: [], tableMissing: false, error: null },
}));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("Find a transfer — empty box shows your balances", () => {
  const t = text(render(EMPTY_SELECTION));
  it("lists each physical card with its statement balance and date", () => {
    expect(t).toContain("Magnus Burgundy ••4455 7,65,241 points · statement 15 Oct 2026");
    expect(t).toContain("Magnus Burgundy ••2294 62,328 points · statement 15 Oct 2026");
    expect(t).toContain("Infinia ••5906 2,26,113 points · statement 15 Oct 2026");
    expect(t).toContain("HSBC Premier ••4502 Balance not saved yet");
    expect(t).toContain("Swiggy ••3034 Cashback card — no transfers");
  });
  it("lists partner balances, marking the ones read from email", () => {
    expect(t).toContain("Hilton Honors 21,315 points · from email, 3 Nov 2026 Auto");
    expect(t).toContain("Marriott Bonvoy 2,25,991 points · you entered it, 15 Aug 2026");
    expect(t).not.toMatch(/Marriott Bonvoy 2,25,991 points · you entered it, 15 Aug 2026 Auto/);
  });
});

describe("Find a transfer — searching Marriott", () => {
  const html = render({ ...EMPTY_SELECTION, programs: ["marriott"] });
  const t = text(html);
  it("heads the results with what you hold and the live sale, not the ended one", () => {
    expect(t).toContain("You hold 2,25,991 points · you entered it, 15 Aug 2026");
    expect(t).toContain("Live deal · Points sale: up to 55% bonus · ends 23 Nov 2026");
    expect(t).not.toContain("Old Marriott sale");
  });
  it("reads the Infinia row end to end: balance, 2:1, block rule, result, live bonus", () => {
    const row = t.slice(t.indexOf("Infinia ••5906"), t.indexOf("HSBC Premier ••4502"));
    expect(row).toContain("2,26,113 points · statement 15 Oct 2026");
    expect(row).toContain("2:1");
    expect(row).toContain("1,13,000 points in Marriott Bonvoy");
    expect(row).toContain("1,35,600 with the live 20% transfer bonus");
    expect(row).toContain("2,26,000 of your points can move");
  });
  it("shows HSBC with an example, and names the cards that can't transfer", () => {
    expect(t).toContain("HSBC Premier ••4502 Balance not saved yet");
    expect(t).toContain("1,00,000 points → 1,00,000 points in Marriott Bonvoy");
    expect(t).toContain("Can't transfer: Magnus Burgundy ••4455 → Marriott Bonvoy · Magnus Burgundy ••2294 → Marriott Bonvoy · Swiggy ••3034 → Marriott Bonvoy");
    expect(html).toContain('aria-label="Remove Marriott Bonvoy"');
  });
});

describe("Find a transfer — searching a card", () => {
  it("Magnus into KrisFlyer: each card converts its own balance, and shows what you hold", () => {
    const t = text(render({ ...EMPTY_SELECTION, products: ["axis_magnus_burgundy"], programs: ["krisflyer"] }));
    expect(t).toContain("6,12,192 miles in Singapore KrisFlyer");
    expect(t).toContain("49,862 miles in Singapore KrisFlyer");
    expect(t).toContain("You hold 31,485 miles · read from email, 1 Oct 2026");
    expect(t.indexOf("6,12,192")).toBeLessThan(t.indexOf("49,862"));
  });
});
