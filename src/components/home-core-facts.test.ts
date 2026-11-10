import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  cards: [] as {id:string;last4:string;nickname:string|null;product_key:string;anniversary_date:string|null}[],
  transactions: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/transactions-cache", () => ({ useTransactionsAll: () => ({ data: {...fixture,last_sync:null}, loading:false }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
import OverviewTab from "./OverviewTab";
import CardsTab from "./CardsTab";
import CardRetentionNote from "./CardRetentionNote";

const card = (product_key="hdfc_infinia",last4="1234",nickname:string|null=null) => ({id:last4,last4,nickname,product_key,anniversary_date:"2024-01-01"});
const txn = (amount_inr:number, txn_type="debit", txn_at="2026-11-03T12:00:00+05:30") => ({id:String(amount_inr),card_last4:"1234",amount_inr,txn_type,txn_at,original_currency:"INR",merchant:"Synthetic test",category:"Shopping"});
const home = () => renderToStaticMarkup(createElement(OverviewTab,{onOpenSpend:()=>{},onNavigate:()=>{}}));
const plain = (html:string) => html.replace(/<[^>]*>/g," ").replace(/\s+/g," ");
beforeEach(() => { vi.useFakeTimers();vi.setSystemTime(new Date("2026-11-10T12:00:00+05:30"));fixture.cards=[card()];fixture.transactions=[]; });
afterEach(() => vi.useRealTimers());

it.each([1_799_999,1_800_000,1_800_001])("never turns recorded spend %s into retention qualification or a reward estimate", amount => {
  fixture.transactions=[txn(amount)];
  const html=home();
  expect(html).toContain('aria-label="Infinia retention condition"');
  expect(plain(html)).toContain("₹18 lakh card spend / financial year");
  expect(plain(html)).toContain("₹50 lakh relationship value");
  expect(plain(html)).not.toMatch(/base-rate estimate|milestones reached|\d+% of|₹[\d,]+ to go/);
  expect(html).not.toContain('role="progressbar"');
});
it("keeps both Magnus accounts free of a generic fee-waiver target", () => {
  fixture.cards=[card("axis_magnus_burgundy","1234"),card("axis_magnus_burgundy","5678","Synthetic second Magnus")];
  fixture.transactions=[txn(3_000_000)];
  const html=home();
  expect(html.match(/class="home-wallet-row"/g)).toHaveLength(2);
  expect(plain(html)).not.toMatch(/anniversary|milestone|base-rate|to go|Reached|% of/);
  expect(html).not.toContain('aria-label="Infinia retention condition"');
});
it("shows gross purchases separately from refunds, and excludes future or malformed money", () => {
  fixture.transactions=[txn(1000),txn(300,"credit"),txn(9999,"debit","2026-11-11T12:00:00+05:30"),txn(8888,"debit","2026-12-01T12:00:00+05:30"),txn(NaN),txn(Infinity),txn(-2)];
  const html=home();const monthly=plain(html.split('aria-label="Monthly spending"')[1].split('</section>')[0]);
  expect(monthly).toContain("₹1,000");expect(monthly).toContain("Refunded ₹300");expect(monthly).toContain("2 transactions");
  expect(html).not.toMatch(/₹700|₹9,999|NaN|Infinity/);
});
it.each(["2026-03-31T18:29:59.999Z","2026-03-31T18:30:00.000Z"])("keeps the reference fixed to Apr–Mar regardless of saved anniversary or date %s", instant => {
  vi.setSystemTime(new Date(instant));
  const text=plain(home());
  expect(text).toContain("1 April–31 March · primary + add-ons");
  expect(text).not.toMatch(/1 Jan|custom start|anniversary/);
});
it("preserves a long identity and unknown product without inventing a spend condition", () => {
  fixture.cards=[card("unknown_card","1234","Synthetic long nickname with detailed family account description")];
  const html=home();
  expect(plain(html)).toContain(fixture.cards[0].nickname);expect(plain(html)).toContain("••1234");
  expect(html).not.toContain('aria-label="Infinia retention condition"');
});
it("keeps an empty wallet useful without claiming a condition or inviting milestone tracking", () => {
  fixture.cards=[];const html=home();
  expect(plain(html)).toContain("No cards yet");expect(plain(html)).toContain("Add a card");
  expect(plain(html)).not.toMatch(/milestone|retention|₹18 lakh/);
});
it("removes Cards' assumed milestone tracker and spending-year editor while retaining account controls", () => {
  const text=plain(renderToStaticMarkup(createElement(CardsTab)));
  expect(text).not.toMatch(/Milestone tracker|Edit spending year|Calendar-year default/);
  expect(text).toContain("Add a card");expect(text).toContain("Gmail connection");expect(text).toContain("Utility and rent bills");
});
it("keeps source and qualification limits inside a closed disclosure, outside interactive wallet buttons", () => {
  const html=renderToStaticMarkup(createElement(CardRetentionNote));
  expect(html).toContain("mitc-in-english.pdf#page=18");expect(html).not.toContain("<details open");
  expect(plain(html)).toContain("does not claim that retention is met");
});
