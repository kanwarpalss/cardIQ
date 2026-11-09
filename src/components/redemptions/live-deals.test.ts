import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DealsView } from "./LiveDeals";
import { dedupKey } from "@/lib/deals/score";
import type { DealsData } from "@/lib/deals/load";
import type { RedemptionsData } from "@/lib/redemptions-data";
import type { DealRun, StoredDeal } from "@/lib/deals/types";

// Shapes taken from the 9 Nov 2026 live dry run over KP's real inbox and the
// blog feeds. The HDFC → Accor bonus is a FIXTURE (no bank bonus was live that
// day) so the "For your cards" section and its arithmetic can be read.
const NOW = Date.parse("2026-11-09T06:30:00Z"); // 12:00 IST

const DATA = {
  cards: [
    { id: "c1", last4: "1111", nickname: null, product_key: "hdfc_infinia" },
    { id: "c2", last4: "2222", nickname: null, product_key: "axis_magnus_burgundy" },
  ],
  loyalty: [{ id: "l1", program_name: "Marriott Bonvoy", program_type: "hotel", member_id: null, tier: null,
    tier_expires_on: null, points_balance: 23456, points_expire_on: null, linked_card: null, notes: null, updated_at: "2026-11-01" }],
  rewards: [], vouchers: [], expiring: [],
  perksTableMissing: false, vouchersTableMissing: false, expiryColumnMissing: false, error: null,
} as unknown as RedemptionsData;

let n = 0;
const deal = (over: Partial<StoredDeal>): StoredDeal => {
  const d: StoredDeal = {
    id: `d${++n}`, dedup_key: "", kind: "buy_points", program: "marriott",
    from_bank: null, from_program: null, from_other: null, bonus_pct: null, discount_pct: null,
    starts_on: null, ends_on: null, targeted: false, headline: "", evidence: "", evidence_verified: true,
    sources: [{ kind: "email", item_id: "1a1a768e21084950", origin: "Points for Marriott Bonvoy Marriott-Bonvoy@points-mail.com",
      title: "t", url: null, seen_at: "2026-11-04T16:07:48Z" }],
    first_seen_at: "2026-11-04T16:07:48Z", last_seen_at: "2026-11-04T16:07:48Z",
    ...over,
  };
  return { ...d, dedup_key: dedupKey(d) };
};

const DEALS: StoredDeal[] = [
  deal({ headline: "Marriott Bonvoy: up to 50% bonus on bought points", bonus_pct: 50, ends_on: "2026-09-09",
    first_seen_at: "2026-08-05T11:33:00Z", last_seen_at: "2026-09-07T16:36:36Z", targeted: true }),
  deal({ headline: "Marriott Bonvoy: up to 55% bonus on bought points", bonus_pct: 55, ends_on: "2026-11-23",
    first_seen_at: "2026-10-14T15:08:55Z", evidence: "Get up to 55% bonus points when you buy" }),
  deal({ headline: "Finnair Plus: 50% off buying Avios", program: "finnair", discount_pct: 50,
    sources: [{ kind: "blog", item_id: "https://www.livefromalounge.com/finnair", origin: "Live From A Lounge", title: "t",
      url: "https://www.livefromalounge.com/finnair", seen_at: "2026-11-04T15:15:27Z" }],
    first_seen_at: "2026-11-04T15:15:27Z", last_seen_at: "2026-11-04T15:15:27Z", evidence_verified: false, evidence: "half price" }),
  deal({ headline: "IHG: up to 100% bonus on bought points", program: "ihg", bonus_pct: 100, ends_on: "2026-11-10" }),
  deal({ kind: "transfer_bonus", headline: "HDFC → Accor: 30% transfer bonus", program: "accor", from_bank: "hdfc",
    bonus_pct: 30, ends_on: "2026-11-30" }),
  deal({ kind: "transfer_bonus", headline: "JAL: 30% bonus from HeyMax", program: "jal", from_other: "HeyMax",
    bonus_pct: 30, ends_on: "2026-11-30" }),
  deal({ kind: "transfer_bonus", headline: "Accor: 50% bonus converting KrisFlyer miles", program: "accor",
    from_program: "krisflyer", bonus_pct: 50, ends_on: "2026-09-30", first_seen_at: "2026-09-09T11:02:59Z", last_seen_at: "2026-09-30T00:00:00Z" }),
];

const RUN_OK: DealRun = { started_at: "2026-11-09T03:00:00Z", finished_at: "2026-11-09T03:01:20Z", ok: true,
  summary: "Checked 476 emails and 44 blog posts; 479 filtered out free, 33 read by AI · 26 deals" };

const render = (deals: Partial<DealsData> = {}) => renderToStaticMarkup(createElement(DealsView, {
  data: DATA, now: NOW,
  deals: { deals: DEALS, runs: [RUN_OK], tableMissing: false, error: null, ...deals },
}));
/** Visible text, tags removed, entities for quotes/apostrophes decoded. */
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("Live deals screen — rendered rows", () => {
  const html = render();
  const t = text(html);

  it("shows the job's health and last summary first", () => {
    expect(t).toContain("Last checked 3 hours ago");
    expect(t).toContain("Checked 476 emails and 44 blog posts");
    expect(t.indexOf("Last checked")).toBeLessThan(t.indexOf("For your cards"));
  });

  it("orders sections: your cards, then points sales, then the rest", () => {
    const at = (s: string) => t.indexOf(s);
    expect(at("For your cards")).toBeGreaterThan(-1);
    expect(at("For your cards")).toBeLessThan(at("Points sales"));
    expect(at("Points sales")).toBeLessThan(at("Not for your cards"));
    expect(at("Not for your cards")).toBeLessThan(at("Recently ended"));
  });

  it("reads the HDFC → Accor row with consistent numbers: 2:1, then +30%", () => {
    // Infinia → Accor is 2:1: 1,00,000 → 50,000; ×1.3 → 65,000. Magnus is
    // Axis, so it must not appear on an HDFC-only bonus.
    expect(t).toContain("Your HDFC points transfer to Accor ALL");
    expect(t).toContain("Infinia : 1,00,000 points → 50,000 points normally, 65,000 with the 30% bonus");
    const accorCard = t.slice(t.indexOf("HDFC → Accor"), t.indexOf("Points sales"));
    expect(accorCard).not.toContain("Magnus");
    expect(accorCard).toContain("30% bonus");
    expect(accorCard).toContain("Ends 30 Nov 2026 · 21 days left");
  });

  it("grades the 55% Marriott sale against the earlier 50% one, and shows his balance", () => {
    const card = t.slice(t.indexOf("up to 55% bonus on bought points"), t.indexOf("IHG Points sale"));
    expect(card).toContain("Bought with cash, direct from Marriott Bonvoy");
    expect(card).toContain("up to 55% bonus");
    expect(card).toContain("Best yet");
    expect(card).toContain("Beats the best of 1 earlier offer since Aug 2026 (was 50%)");
    expect(card).toContain("You hold 23,456 points");
    expect(card).toContain("Ends 23 Nov 2026 · 14 days left");
    expect(html).toContain('href="https://mail.google.com/mail/u/0/#all/1a1a768e21084950"');
    expect(card).toContain("Email from Points for Marriott Bonvoy");
  });

  it("flags blog-only, unverified, no-end-date and ending-tomorrow deals in words", () => {
    const finnair = t.slice(t.indexOf("Finnair Plus: 50% off"), t.indexOf("Not for your cards"));
    expect(finnair).toContain("50% off");
    expect(finnair).toContain("From a blog, unconfirmed");
    expect(finnair).toContain("No end date given");
    expect(finnair).toContain("Couldn't match this quote");
    const ihg = t.slice(t.indexOf("IHG Points sale"), t.indexOf("Finnair Plus: 50% off"));
    expect(ihg).toContain("Ends tomorrow");
    // Ranked by grade, then soonest end: the 55% "best yet" Marriott sale
    // leads, then IHG ending tomorrow, then Finnair with no end date.
    expect(t.indexOf("Marriott Bonvoy: up to 55%")).toBeLessThan(t.indexOf("IHG Points sale"));
  });

  it("collapses the not-for-you and ended sections to their headers", () => {
    expect(t).toContain("Not for your cards (1)");
    // The 50% Marriott sale was last seen 7 Sep — over 60 days ago — so only
    // the KrisFlyer → Accor bonus (last seen 30 Sep) is still listed.
    expect(t).toContain("Recently ended (1)");
    expect(t).not.toContain("JAL: 30% bonus from HeyMax");
    expect(t).not.toContain("converting KrisFlyer miles");
  });

  it("puts a failed run in front of the deals, with its reason", () => {
    const failed = text(render({ runs: [{ ...RUN_OK, ok: false, summary: "Failed: no Gmail app password — save one in Cards → Settings" }, RUN_OK] }));
    expect(failed).toContain("Last check failed 3 hours ago: no Gmail app password");
  });

  it("asks for migration 024 when the tables don't exist", () => {
    const missing = text(render({ deals: [], runs: [], tableMissing: true }));
    expect(missing).toContain("supabase/migrations/024_deals.sql");
  });
});
