import { describe, it, expect } from "vitest";
import { TRANSFER_SPECS } from "./cards";
import { CARD_REGISTRY } from "@/lib/cards/registry";
import { matchesQuery, suggest, searchCombos, EMPTY_SELECTION, type SearchCard } from "./search";

// KP's physical cards with the balances his October statements state.
const card = (id: string, pk: string, last4: string, amount: number | null): SearchCard => ({
  id, product_key: pk, short: pk, name: CARD_REGISTRY[pk].display_name, issuer: CARD_REGISTRY[pk].issuer, last4,
  spec: TRANSFER_SPECS[pk], balance: amount == null ? null : { amount, as_of: "2026-10-15", fromStatement: true },
});
const CARDS = [
  card("a1", "axis_magnus_burgundy", "4455", 765241),
  card("a2", "axis_magnus_burgundy", "2294", 62328),
  card("h1", "hdfc_infinia", "5906", 226113),
  card("i1", "icici_emeralde_private_metal", "9004", null),
  card("s1", "hdfc_swiggy", "3034", null),
  card("p1", "hsbc_premier", "4502", null),
];

describe("matchesQuery", () => {
  it("matches word prefixes, all words required", () => {
    expect(matchesQuery("Marriott Bonvoy MB points", "mar bon")).toBe(true);
    expect(matchesQuery("Marriott Bonvoy", "bonvoy hilton")).toBe(false);
    expect(matchesQuery("Lufthansa Miles & More", "milesandmore")).toBe(false);
    expect(matchesQuery("Lufthansa Miles & More", "milesmore")).toBe(true);
    expect(matchesQuery("anything", "  ")).toBe(false);
  });
});

describe("suggest", () => {
  it("offers the card by name, issuer or last 4 digits — once per product", () => {
    for (const q of ["infinia", "hdfc inf", "5906"]) {
      const s = suggest(q, CARDS, EMPTY_SELECTION);
      expect(s[0], q).toMatchObject({ kind: "card", product_key: "hdfc_infinia" });
    }
    expect(suggest("magnus", CARDS, EMPTY_SELECTION).filter((s) => s.kind === "card")).toHaveLength(1);
  });

  it("offers programs by name, alias or currency, reachable ones first", () => {
    expect(suggest("bonvoy", CARDS, EMPTY_SELECTION)[0]).toMatchObject({ kind: "program", program: "marriott" });
    const avios = suggest("avios", CARDS, EMPTY_SELECTION);
    expect(avios.some((s) => s.kind === "group" && s.group === "avios")).toBe(true);
    expect(avios.some((s) => s.kind === "program" && s.program === "qatar_avios")).toBe(true);
  });

  it("doesn't re-offer what's already selected", () => {
    expect(suggest("marriott", CARDS, { ...EMPTY_SELECTION, programs: ["marriott"] }).some((s) => s.kind === "program" && s.program === "marriott")).toBe(false);
  });
});

describe("searchCombos", () => {
  it("nothing selected → nothing listed", () => {
    expect(searchCombos(EMPTY_SELECTION, CARDS)).toEqual({ rows: [], unreachable: [] });
  });

  it("Marriott: Infinia's real balance converts at 2:1, HSBC 1:1 without a balance, Axis can't", () => {
    const r = searchCombos({ ...EMPTY_SELECTION, programs: ["marriott"] }, CARDS);
    const infinia = r.rows.find((x) => x.card.id === "h1")!;
    expect(infinia.path.hops.map((h) => h.program)).toEqual(["marriott"]);
    // HDFC moves points in blocks of 1,000: 2,26,000 of 2,26,113 can go, at 2:1.
    expect(infinia.units).toBe(113000);
    expect(infinia.usable).toBe(226000);
    const hsbc = r.rows.find((x) => x.card.id === "p1")!;
    expect(hsbc).toMatchObject({ units: null, sample: 100000 });
    // Real balances sort ahead of examples.
    expect(r.rows[0].card.id).toBe("h1");
    // Axis dropped Marriott (Apr 2026); both Axis cards and the cashback cards are listed as unreachable.
    expect(r.unreachable.map((u) => u.card.id).sort()).toEqual(["a1", "a2", "i1", "s1"]);
  });

  it("each Axis card converts its own balance (5:4 into KrisFlyer)", () => {
    const r = searchCombos({ ...EMPTY_SELECTION, products: ["axis_magnus_burgundy"], programs: ["krisflyer"] }, CARDS);
    expect(r.rows.map((x) => [x.card.last4, x.units])).toEqual([["4455", 612192], ["2294", 49862]]);
  });

  it("a card alone lists every partner it reaches, including bridged ones", () => {
    const r = searchCombos({ ...EMPTY_SELECTION, products: ["hdfc_infinia"] }, CARDS);
    const programs = new Set(r.rows.map((x) => x.program));
    expect(programs.has("accor")).toBe(true);
    // Infinia → Finnair 1:1 → Qatar Avios 1:1 beats the direct 2:1.
    const qatar = r.rows.find((x) => x.program === "qatar_avios")!;
    expect(qatar.path.hops.map((h) => h.program)).toEqual(["finnair", "qatar_avios"]);
    expect(qatar.units).toBe(226000);
  });

  it("groups narrow the list: hotels for Infinia, Avios across all cards", () => {
    const hotels = searchCombos({ ...EMPTY_SELECTION, products: ["hdfc_infinia"], groups: ["hotel"] }, CARDS);
    expect(hotels.rows.every((x) => ["accor", "marriott", "club_itc", "ihg", "radisson", "wyndham"].includes(x.program))).toBe(true);
    const avios = searchCombos({ ...EMPTY_SELECTION, groups: ["avios"] }, CARDS);
    expect(avios.rows.length).toBeGreaterThan(0);
    expect(avios.rows.every((x) => ["qatar_avios", "ba_avios", "iberia", "finnair"].includes(x.program))).toBe(true);
  });

  it("a cashback card searched alone gives no rows rather than an error", () => {
    expect(searchCombos({ ...EMPTY_SELECTION, products: ["hdfc_swiggy"] }, CARDS).rows).toEqual([]);
  });
});
