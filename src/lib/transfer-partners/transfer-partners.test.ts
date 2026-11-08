import { describe, it, expect } from "vitest";
import { PROGRAMS, BRIDGES, type ProgramKey } from "./programs";
import { TRANSFER_SPECS } from "./cards";
import { ROUTES } from "./routes";
import {
  convert, usablePoints, pathsTo, convertAlong, bestPath, matchProgram, strength, fmtRatio,
  betterIndirect, parsePointsInput,
} from "./math";
import { CARD_REGISTRY } from "@/lib/cards/registry";

const spec = (k: string) => TRANSFER_SPECS[k];
const programs = (k: string) => spec(k).partners.map((p) => p.program);
const ratioOf = (k: string, program: ProgramKey) =>
  spec(k).partners.find((p) => p.program === program)?.ratio;

describe("transfer partner data", () => {
  it("covers every card in the registry", () => {
    for (const key of Object.keys(CARD_REGISTRY)) expect(TRANSFER_SPECS[key], key).toBeDefined();
  });

  it("only points at programs in the catalog, once each, with positive whole ratios", () => {
    for (const s of Object.values(TRANSFER_SPECS)) {
      const seen = new Set<string>();
      for (const t of s.partners) {
        expect(PROGRAMS[t.program], `${s.product_key} → ${t.program}`).toBeDefined();
        expect(seen.has(t.program), `${s.product_key} lists ${t.program} twice`).toBe(false);
        seen.add(t.program);
        for (const n of [t.ratio.from, t.ratio.to]) {
          expect(Number.isInteger(n) && n > 0, `${s.product_key} → ${t.program}`).toBe(true);
        }
      }
    }
  });

  it("every partner card names its sources and a check date", () => {
    for (const s of Object.values(TRANSFER_SPECS)) {
      expect(s.checked_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (s.partners.length) expect(s.sources.length, s.product_key).toBeGreaterThan(0);
      else expect(s.none_reason, s.product_key).toBeTruthy();
    }
  });

  it("bridges only join real programs, never a program to itself", () => {
    for (const b of BRIDGES) {
      expect(PROGRAMS[b.from]).toBeDefined();
      expect(PROGRAMS[b.to]).toBeDefined();
      expect(b.from).not.toBe(b.to);
    }
  });

  it("never offers an airline-to-airline bridge outside the Avios family", () => {
    const avios = new Set(["qatar_avios", "ba_avios", "iberia", "finnair"]);
    for (const b of BRIDGES) {
      if (PROGRAMS[b.from].kind === "airline") {
        expect(avios.has(b.from) && avios.has(b.to), `${b.from} → ${b.to}`).toBe(true);
      }
    }
  });

  it("every route is reachable from at least one card", () => {
    for (const r of ROUTES) {
      expect(bestPath(Object.values(TRANSFER_SPECS), r.target), r.id).not.toBeNull();
    }
  });

  // Removals and exclusions a future edit could silently undo.
  it("Axis no longer reaches Marriott or ITC (removed 2026)", () => {
    expect(programs("axis_magnus_burgundy")).not.toContain("marriott");
    expect(programs("axis_magnus_burgundy")).not.toContain("club_itc");
  });

  it("HSBC doesn't reach Aeroplan (points.casa says no; only one guide says yes)", () => {
    expect(programs("hsbc_travelone")).not.toContain("aeroplan");
    expect(programs("hsbc_premier")).not.toContain("aeroplan");
  });

  it("disputed HSBC ratios use the less generous claim", () => {
    for (const p of ["turkish", "united", "hainan", "eva"] as ProgramKey[]) {
      expect(ratioOf("hsbc_travelone", p), p).toEqual({ from: 2, to: 1 });
      expect(spec("hsbc_travelone").partners.find((t) => t.program === p)?.disputed, p).toBeTruthy();
    }
  });

  it("ICICI EPM reaches Air India only, at 1:1", () => {
    expect(spec("icici_emeralde_private_metal").partners).toEqual([
      { program: "air_india", ratio: { from: 1, to: 1 } },
    ]);
  });

  it("Amex no longer reaches Etihad (left 1 Jul 2026)", () => {
    expect(programs("amex_platinum_travel")).not.toContain("etihad");
  });
});

describe("convert", () => {
  it("applies ratios and drops fractions", () => {
    expect(convert(1000, { from: 5, to: 4 })).toBe(800);
    expect(convert(999, { from: 5, to: 2 })).toBe(399); // 399.6 → 399, never rounded up
    expect(convert(1, { from: 5, to: 4 })).toBe(0);
    expect(convert(1001, { from: 2, to: 3 })).toBe(1501); // 1501.5
    expect(convert(10, { from: 1, to: 3 })).toBe(30);
    expect(convert(4, { from: 5, to: 1 })).toBe(0);
  });

  it("treats junk input as zero", () => {
    for (const bad of [0, -1000, NaN, Infinity, -Infinity]) {
      expect(convert(bad, { from: 1, to: 1 }), String(bad)).toBe(0);
    }
    expect(convert(1000, { from: 0, to: 1 })).toBe(0);
    expect(convert(1000, { from: 1, to: -1 })).toBe(0);
  });

  it("floors fractional points before converting", () => {
    expect(convert(1000.9, { from: 5, to: 4 })).toBe(800);
  });

  it("stays exact on large balances", () => {
    expect(convert(1_00_00_000, { from: 5, to: 4 })).toBe(80_00_000);
    expect(convert(123_456_789, { from: 5, to: 2 })).toBe(49_382_715);
  });

  it("adds the Marriott bonus per full 60,000 block only", () => {
    const m = { from: 3, to: 1 }, bonus = { per: 60000, extra: 5000 };
    expect(convert(59999, m, bonus)).toBe(19999);
    expect(convert(60000, m, bonus)).toBe(25000);
    expect(convert(119999, m, bonus)).toBe(44999);
    expect(convert(120000, m, bonus)).toBe(50000);
  });
});

describe("usablePoints", () => {
  const hdfc = { min: 1000, increment: 1000 };
  it("respects HDFC's 1,000 minimum and multiples", () => {
    expect(usablePoints(999, hdfc)).toBe(0);
    expect(usablePoints(1000, hdfc)).toBe(1000);
    expect(usablePoints(1999, hdfc)).toBe(1000);
    expect(usablePoints(250500, hdfc)).toBe(250000);
  });
  it("enforces a minimum on its own (ICICI: 1,000, no multiple rule)", () => {
    const icici = spec("icici_emeralde_private_metal");
    expect(usablePoints(999, icici)).toBe(0);
    expect(usablePoints(1001, icici)).toBe(1001);
  });
  it("passes any whole amount through when there are no rules", () => {
    expect(usablePoints(7)).toBe(7);
    expect(usablePoints(7.9)).toBe(7);
    expect(usablePoints(-5)).toBe(0);
    expect(usablePoints(NaN)).toBe(0);
  });
});

describe("pathsTo", () => {
  it("finds a direct transfer", () => {
    const [p] = pathsTo(spec("axis_magnus_burgundy"), "krisflyer");
    expect(p.hops.map((h) => h.program)).toEqual(["krisflyer"]);
    expect(convertAlong(10000, p)).toBe(8000);
  });

  it("reaches Iberia only through an Avios bridge", () => {
    const paths = pathsTo(spec("hsbc_travelone"), "iberia");
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p.hops).toHaveLength(2);
    expect(convertAlong(10000, paths[0])).toBe(10000);
  });

  it("picks the better bridge entry: Infinia → Finnair 1:1 beats Qatar 2:1", () => {
    const [p] = pathsTo(spec("hdfc_infinia"), "iberia");
    expect(p.hops[0].program).toBe("finnair");
    expect(convertAlong(10000, p, spec("hdfc_infinia"))).toBe(10000);
  });

  it("chains Marriott's ratio and bonus correctly", () => {
    const [aa] = pathsTo(spec("hsbc_travelone"), "aadvantage");
    expect(aa.hops.map((h) => h.program)).toEqual(["marriott", "aadvantage"]);
    expect(convertAlong(60000, aa)).toBe(20000); // American: no bonus

    const ac = pathsTo(spec("hsbc_travelone"), "aeroplan");
    expect(ac[0].hops.map((h) => h.program)).toEqual(["marriott", "aeroplan"]);
    expect(convertAlong(60000, ac[0])).toBe(25000); // 20,000 + 5,000 bonus
  });

  it("floors at every hop: Infinia → Marriott 2:1 → American 3:1", () => {
    const [p] = pathsTo(spec("hdfc_infinia"), "aadvantage");
    // 100,001 → 1,00,000 usable (multiples of 1,000) → 50,000 Marriott → 16,666 AA
    expect(convertAlong(100001, p, spec("hdfc_infinia"))).toBe(16666);
  });

  it("returns nothing when a card can't get there", () => {
    expect(pathsTo(spec("icici_emeralde_private_metal"), "krisflyer")).toEqual([]);
    expect(pathsTo(spec("hdfc_swiggy"), "air_india")).toEqual([]);
  });
});

describe("betterIndirect", () => {
  it("finds Infinia → Finnair 1:1 → Qatar beating Infinia → Qatar 2:1", () => {
    const p = betterIndirect(spec("hdfc_infinia"), "qatar_avios");
    expect(p?.hops.map((h) => h.program)).toEqual(["finnair", "qatar_avios"]);
    expect(convertAlong(10000, p!, spec("hdfc_infinia"))).toBe(10000);
  });
  it("stays null when direct is already as good", () => {
    expect(betterIndirect(spec("hsbc_travelone"), "qatar_avios")).toBeNull(); // 1:1 direct
    expect(betterIndirect(spec("axis_magnus_burgundy"), "ba_avios")).toBeNull(); // all Avios entries 5:2: a tie
  });
});

describe("parsePointsInput", () => {
  it("reads Indian and western digit grouping", () => {
    expect(parsePointsInput("1,00,000")).toBe(100000);
    expect(parsePointsInput("100,000")).toBe(100000);
    expect(parsePointsInput(" 2 40 500 ")).toBe(240500);
    expect(parsePointsInput("1500.9")).toBe(1500);
  });
  it("is 0 for anything that isn't a plain number", () => {
    for (const bad of ["", "abc", "-500", "1e5", "₹500", "12k", "1.2.3"]) {
      expect(parsePointsInput(bad), bad).toBe(0);
    }
  });
});

describe("bestPath", () => {
  it("picks the most generous card", () => {
    const specs = ["axis_magnus_burgundy", "hsbc_travelone", "hdfc_infinia"].map(spec);
    expect(bestPath(specs, "krisflyer")?.product_key).toBe("hsbc_travelone"); // 1:1 beats 5:4
    expect(bestPath(specs, "aeroplan")?.product_key).toBe("axis_magnus_burgundy"); // 5:4 direct
  });
  it("returns null when no card reaches", () => {
    expect(bestPath([spec("hdfc_swiggy")], "krisflyer")).toBeNull();
    expect(bestPath([], "krisflyer")).toBeNull();
  });
});

describe("matchProgram", () => {
  it("recognises the names already saved in Miles & status", () => {
    expect(matchProgram("KrisFlyer Singapore Airlines")).toBe("krisflyer");
    expect(matchProgram("Marriott Bonvoy")).toBe("marriott");
    expect(matchProgram("Accor ALL")).toBe("accor");
    expect(matchProgram("Hilton Honors")).toBe("hilton");
  });
  it("prefers the longest alias", () => {
    expect(matchProgram("Lufthansa Miles & More")).toBe("miles_and_more");
    expect(matchProgram("Qatar Airways Privilege Club")).toBe("qatar_avios");
  });
  it("returns null for unknown programs", () => {
    expect(matchProgram("Some Café Loyalty")).toBeNull();
    expect(matchProgram("")).toBeNull();
  });
});

describe("display helpers", () => {
  it("grades ratio strength", () => {
    expect(strength({ from: 1, to: 3 })).toBe("strong");
    expect(strength({ from: 1, to: 1 })).toBe("strong");
    expect(strength({ from: 5, to: 4 })).toBe("good");
    expect(strength({ from: 2, to: 1 })).toBe("fair");
    expect(strength({ from: 5, to: 2 })).toBe("weak");
    expect(strength({ from: 5, to: 1 })).toBe("weak");
  });
  it("formats ratios as bank-side:partner-side", () => {
    expect(fmtRatio({ from: 5, to: 4 })).toBe("5:4");
  });
});
