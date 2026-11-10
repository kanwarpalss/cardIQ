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

const render = (deals: Partial<DealsData> = {}, extra: { initialAdding?: boolean } = {}) => renderToStaticMarkup(createElement(DealsView, {
  data: DATA, now: NOW, onSave: async () => null, onDelete: async () => null, ...extra,
  deals: { deals: DEALS, runs: [RUN_OK], tableMissing: false, error: null, ...deals },
}));
/** Visible text, tags removed, entities for quotes/apostrophes decoded. */
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&").replace(/\s+/g, " ");


/** One deal's row — from its program name on the row to the next row's start. */
const rowOf = (html: string, headline: string) => {
  const rows = html.split(/(?=<details class="group )/).slice(1).map(text);
  const row = rows.find((r) => r.includes(headline));
  if (!row) throw new Error(`no row for ${headline}`);
  return row;
};

describe("Live deals screen — layout", () => {
  const html = render();
  const t = text(html);

  it("opens with one quiet status line and the Add button; the run stats only on hover", () => {
    expect(t).toMatch(/^ ?4 live deals you can use Last checked 3 hours ago \+ Add a deal/);
    expect(t).not.toContain("Checked 476 emails");
    expect(html).toContain('title="Checked 476 emails and 44 blog posts');
  });

  it("orders groups: your cards, then points sales, then the folded-away rest", () => {
    const at = (s: string) => t.indexOf(s);
    expect(at("Transfer bonuses for your cards · 1")).toBeGreaterThan(-1);
    expect(at("Transfer bonuses for your cards")).toBeLessThan(at("Points sales · 3"));
    expect(at("Points sales · 3")).toBeLessThan(at("Not for your cards · 1"));
    expect(at("Not for your cards · 1")).toBeLessThan(at("Ended in the last 60 days · 1"));
    // Folded groups and every row start closed: nothing is open on arrival.
    expect(html).not.toMatch(/<details[^>]* open/);
  });

  it("each row's face says program · type · figure · time, nothing more", () => {
    const accor = rowOf(html, "HDFC → Accor");
    expect(accor.slice(0, accor.indexOf("HDFC → Accor"))).toMatch(/^ ?AC? ?\w* ?Accor ALL Transfer bonus from HDFC 30% bonus 21 days left $/);
    const marriott = rowOf(html, "up to 55% bonus on bought points");
    // A live points sale sits under "Points sales": its row shows grade and balance instead.
    expect(marriott).toMatch(/Marriott Bonvoy Best yet · You hold 23,456 55% bonus 14 days left/);
  });
});

describe("Live deals screen — what's inside a row", () => {
  const html = render();

  it("HDFC → Accor: 2:1, then +30%, and no Axis card on an HDFC-only bonus", () => {
    // Infinia → Accor is 2:1: 1,00,000 → 50,000; ×1.3 → 65,000.
    const row = rowOf(html, "HDFC → Accor");
    expect(row).toContain("Ends 30 Nov 2026 · 21 days left");
    expect(row).toContain("For you Your HDFC points transfer to Accor ALL");
    expect(row).toContain("Infinia: 1,00,000 points → 50,000 points normally, 65,000 with the 30% bonus");
    expect(row).not.toContain("Magnus");
  });

  it("Marriott 55%: graded against the earlier 50%, with his balance, the quote and the email link", () => {
    const row = rowOf(html, "up to 55% bonus on bought points");
    expect(row).not.toContain("For you");
    expect(row).toContain("Compared Beats the best of 1 earlier offer since Aug 2026 (was 50%)");
    expect(row).toContain("You hold 23,456 points");
    expect(row).toContain('It says “Get up to 55% bonus points when you buy”');
    expect(row).toContain("Email from Points for Marriott Bonvoy, 4 Nov 2026");
    expect(html).toContain('href="https://mail.google.com/mail/u/0/#all/1a1a768e21084950"');
    expect(row).not.toContain("Delete");
  });

  it("says blog-only, unmatched-quote, no-end-date and ending-tomorrow in words", () => {
    const finnair = rowOf(html, "Finnair Plus: 50% off");
    expect(finnair).toMatch(/Finnair Plus Points sale 50% off No end date/); // nothing else to say → type
    expect(finnair).toContain("From a blog, unconfirmed");
    expect(finnair).toContain("Couldn't match this quote");
    expect(finnair).toContain("No end date given — check before you buy");
    expect(rowOf(html, "IHG: up to 100%")).toContain("100% bonus Ends tomorrow");
    // Ranked by grade, then soonest end.
    const t = text(html);
    expect(t.indexOf("up to 55% bonus on bought")).toBeLessThan(t.indexOf("IHG: up to 100%"));
    expect(t.indexOf("IHG: up to 100%")).toBeLessThan(t.indexOf("Finnair Plus: 50% off"));
  });

  it("folds deals not for his cards and recently ended ones away; drops ones older than 60 days", () => {
    const t = text(html);
    expect(t.indexOf("JAL: 30% bonus from HeyMax")).toBeGreaterThan(t.indexOf("Not for your cards · 1"));
    expect(t.indexOf("converting KrisFlyer miles")).toBeGreaterThan(t.indexOf("Ended in the last 60 days · 1"));
    expect(t).not.toContain("up to 50% bonus on bought points"); // last seen 7 Sep
  });
});

describe("Live deals screen — deals he adds himself", () => {
  const mine = deal({ headline: "Hilton Honors: 40% bonus on bought points", program: "hilton", bonus_pct: 40, ends_on: "2026-11-20",
    evidence: "App-only", sources: [{ kind: "manual", item_id: "m1", origin: "You", title: "t", url: "https://hilton.com/buy", seen_at: "2026-11-09T05:00:00Z" }] });
  const html = render({ deals: [...DEALS, mine] });

  it("shows as his, with his note, his link and a Delete button", () => {
    const row = rowOf(html, "Hilton Honors: 40%");
    expect(row).toMatch(/Hilton Honors Added by you 40% bonus 11 days left/);
    expect(row).toContain("Your note App-only");
    expect(row).not.toContain("“App-only”");
    expect(row).toContain("Added by you, 9 Nov 2026 Delete");
    expect(html).toContain('href="https://hilton.com/buy"');
    expect(row).not.toMatch(/unconfirmed|Couldn't match/);
  });

  it("the Add form offers both deal types, every program and his banks first", () => {
    const form = text(render({}, { initialAdding: true }));
    expect(form).toContain("Add a deal Points sale Transfer bonus");
    expect(form).toContain("Bonus points % off");
    expect(form).toContain("Marriott Bonvoy");
    expect(form).toContain("Save deal");
    expect(form).not.toContain("+ Add a deal");
  });
});

describe("Live deals screen — health and setup", () => {
  it("puts a failed run in the status line, with its reason", () => {
    const failed = text(render({ runs: [{ ...RUN_OK, ok: false, summary: "Failed: no Gmail app password — save one in Cards → Settings" }, RUN_OK] }));
    expect(failed).toContain("Last check failed 3 hours ago: no Gmail app password");
  });

  it("an empty list says so and still offers Add", () => {
    const empty = text(render({ deals: [] }));
    expect(empty).toContain("No live deals right now");
    expect(empty).toContain("+ Add a deal");
  });

  it("asks for migration 024 when the tables don't exist", () => {
    const missing = text(render({ deals: [], runs: [], tableMissing: true }));
    expect(missing).toContain("supabase/migrations/024_deals.sql");
  });
});
