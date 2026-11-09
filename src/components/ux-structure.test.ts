import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[] }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState(initial: unknown) {
    const i = hooks.cursor++;
    if (!(i in hooks.values)) hooks.values[i] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[i], (next: unknown) => { hooks.values[i] = typeof next === "function" ? (next as (p: unknown) => unknown)(hooks.values[i]) : next; }];
  },
  useMemo: (fn: () => unknown) => fn(), useEffect: () => {}, useRef: () => ({ current: null }),
  useCallback: (fn: unknown) => fn,
}));
import TransferPartners from "./redemptions/TransferPartners";
import PartnerGrid from "./redemptions/PartnerGrid";
import RouteCards from "./redemptions/RouteCards";
import ReviewTab from "./ReviewTab";
import { buildWallet } from "./redemptions/transfer-ui";
import type { RedemptionsData } from "@/lib/redemptions-data";
import { TABS } from "./AppNavigation";

type Node = ReactElement<Record<string, unknown>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const named = (tree: unknown, name: string) => nodes(tree).find(n => typeof n.type === "function" && n.type.name === name)!;
const label = (tree: unknown, name: string) => nodes(tree).find(n => n.props["aria-label"] === name)!;
function text(tree: unknown) { return renderToStaticMarkup(tree as ReactElement).replace(/<[^>]*>/g, " ").replace(/\s+/g, " "); }
const data: RedemptionsData = {
  cards: [{id:"a",last4:"1234",nickname:null,product_key:"hsbc_premier"},{id:"b",last4:"5678",nickname:null,product_key:"hdfc_infinia"}],
  loyalty:[],rewards:[],vouchers:[],expiring:[],perksTableMissing:false,vouchersTableMissing:false,expiryColumnMissing:false,error:null,
};
const transfer = () => { hooks.cursor = 0; return TransferPartners({data,onAddCard:vi.fn()}); };
beforeEach(() => { hooks.cursor = 0; hooks.values.length = 0; });
it("has no redundant standalone Insights destination", () => { expect(TABS).not.toContain("Insights"); });
it("defaults to comparison while preserving the other view trees out of sight", () => {
  const tree = transfer();
  for (const [name, hidden] of [["PartnerGrid", false],["RouteCards",true]] as const) {
    const child = named(tree,name);
    expect(nodes(tree).find(n => n.props.children === child)?.props.hidden).toBe(hidden);
  }
  const calculator = named(tree, "CardSnapshot");
  expect(nodes(tree).find(n => n.type === "section" && nodes(n).includes(calculator))?.props.hidden).toBe(true);
});
it("a comparison ratio picks the exact card/program, clears the calculator filter and opens its view", () => {
  const grid = named(transfer(), "PartnerGrid");
  (grid.props.onPick as (card: string, program: string) => void)("hdfc_infinia", "krisflyer");
  const tree = transfer(); const calc = named(tree,"CardSnapshot");
  expect((calc.props.card as {product_key: string}).product_key).toBe("hdfc_infinia");
  expect(calc.props.openProgram).toBe("krisflyer"); expect(calc.props.filter).toBe("all");
  expect(nodes(tree).find(n => n.type === "section" && n.props.ref)?.props.hidden).toBe(false);
});
it.each(["  SINGAPORE  ", "\"", "    "])("partner search treats %s literally, trims whitespace and ignores case", query => {
  const wallet = buildWallet(data); const render = () => { hooks.cursor=0; return PartnerGrid({wallet,onPick:vi.fn()}); };
  (label(render(), "Search transfer partners").props.onChange as (e: {target:{value:string}})=>void)({target:{value:query}});
  const output = text(render());
  if(query.includes("SINGAPORE")) { expect(output).toContain("Singapore KrisFlyer"); expect(output).not.toContain("Accor ALL"); }
  else if(query === "\"") expect(output).toContain("No partners match");
  else expect(output).toContain("Accor ALL");
});
it("combines partner group and search rather than showing results from another group", () => {
  const wallet=buildWallet(data); const render=()=>{hooks.cursor=0;return PartnerGrid({wallet,onPick:vi.fn()});};
  (label(render(),"Search transfer partners").props.onChange as (e:{target:{value:string}})=>void)({target:{value:"singapore"}});
  (label(render(),"Partner group").props.onChange as (e:{target:{value:string}})=>void)({target:{value:"hotel"}});
  expect(text(render())).toContain("No partners match");
});
it("gives cards with no transfer partners a useful comparison state", () => {
  const wallet=buildWallet({...data,cards:[{...data.cards[0],product_key:"hdfc_swiggy"}]}).filter(c=>c.spec.partners.length);
  expect(text(PartnerGrid({wallet,onPick:vi.fn()}))).toContain("no transfer partners");
});
it("route prose and alternatives are in closed disclosures, not the default recommendation", () => {
  const tree=RouteCards({wallet:buildWallet(data),holdings:new Map()});
  const html=renderToStaticMarkup(tree);
  expect(html).toContain("more routes"); expect(html).not.toMatch(/<details[^>]* open/);
  expect(html).toContain("Why this route &amp; things to know");
});
function reviewOrders(count: number) {
  return Array.from({length:count},(_,i)=>({id:String(i),source:"generic",kind:"order",order_ref:null,merchant_name:`Synthetic merchant ${String(i+1).padStart(3,"0")}`,total_amount:100,order_at:"2026-11-01T12:00:00Z",items:[],match_confidence:"medium",review_status:"pending",txn:null}));
}
const review=()=>{hooks.cursor=0;return ReviewTab({});};
it.each([0,1,10,11,21])("bounds review queue rendering for %s matches", count => {
  hooks.values[1]=reviewOrders(count);hooks.values[2]=false;
  const output=text(review());
  if(count>0) expect(output).toContain("Synthetic merchant 001");
  if(count>10) {expect(output).not.toContain("Synthetic merchant 011");expect(label(review(),"Next review page")).toBeDefined();}
  if(count<=10) expect(label(review(),"Next review page")).toBeUndefined();
});
it("review final-page shrinking never shows an empty page of surviving matches", () => {
  hooks.values[1]=reviewOrders(21);hooks.values[2]=false;hooks.values[6]=3;
  expect(text(review())).toContain("Synthetic merchant 021");
  hooks.values[1]=reviewOrders(10);
  expect(text(review())).toContain("Synthetic merchant 001");
});
