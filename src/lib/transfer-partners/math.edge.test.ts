// Edge cases for the transfer maths and name matching, forged by the
// boundary-prover pass on 2026-11-09. The first block failed on the original
// code (NaN/Infinity leaks, substring name matches, fixed-amount ranking);
// the rest guard behaviour that already held.

import { describe, it, expect } from "vitest";
import { PROGRAMS, BRIDGES, type ProgramKey } from "./programs";
import { TRANSFER_SPECS, type TransferSpec } from "./cards";
import {
  convert, usablePoints, pathsTo, convertAlong, bestPath, matchProgram, strength, parsePointsInput,
  twoStepOptions,
} from "./math";

const spec = (k: string) => TRANSFER_SPECS[k];
const synth = (partners: TransferSpec["partners"], extra: Partial<TransferSpec> = {}): TransferSpec => ({
  product_key: "synthetic", partners, rules: [], sources: [], checked_on: "2026-11-08", ...extra,
});

// ── Regressions: each of these failed on the first version ──────────────────
describe("convert never returns NaN / Infinity / negative", () => {
  const out = (n: number) => Number.isFinite(n) && n >= 0;

  it("convert_detects_infinity_from_huge_finite_balance", () => {
    // 1.79e308 points * 2 overflows to Infinity; Infinity then reaches the screen.
    expect(out(convert(Number.MAX_VALUE, { from: 1, to: 2 }))).toBe(true);
  });

  it("convert_detects_infinity_from_non_finite_ratio_to", () => {
    expect(out(convert(100, { from: 1, to: Infinity }))).toBe(true);
  });

  it("convert_detects_NaN_from_zero_bonus_block", () => {
    // per:0 → p/0 = Infinity; Infinity * 0 = NaN
    expect(out(convert(100, { from: 1, to: 1 }, { per: 0, extra: 0 }))).toBe(true);
  });

  it("convert_detects_infinity_from_zero_per_bonus", () => {
    expect(out(convert(100, { from: 1, to: 1 }, { per: 0, extra: 5 }))).toBe(true);
  });

  it("convert_detects_negative_bonus_block_size", () => {
    // per:-10 → floor(100 / -10) * 5 = -50, so 100 points "convert" to 50.
    expect(convert(100, { from: 1, to: 1 }, { per: -10, extra: 5 })).toBeGreaterThanOrEqual(100);
  });

  it("convert_detects_NaN_bonus_fields", () => {
    expect(out(convert(100, { from: 1, to: 1 }, { per: 10, extra: NaN }))).toBe(true);
    expect(out(convert(100, { from: 1, to: 1 }, { per: NaN, extra: 5 }))).toBe(true);
  });

  it("convertAlong_detects_infinity_end_to_end", () => {
    const [p] = pathsTo(spec("hsbc_travelone"), "krisflyer");
    expect(out(convertAlong(Number.MAX_VALUE, p, spec("hsbc_travelone")))).toBe(true);
  });
});

describe("strength() agrees with convert() on unusable ratios", () => {
  it("strength_detects_zero_from_ratio_graded_strong_while_convert_gives_0", () => {
    const r = { from: 0, to: 1 };
    expect(convert(1000, r)).toBe(0);
    expect(strength(r)).not.toBe("strong");
  });
  it("strength_detects_negative_both_sides_graded_strong", () => {
    const r = { from: -1, to: -1 };
    expect(convert(1000, r)).toBe(0);
    expect(strength(r)).not.toBe("strong");
  });
});

describe("matchProgram: whole words, odd spacing, null", () => {
  it("matchProgram_detects_substring_false_positive_jal", () => {
    expect(matchProgram("Kajal Salon Rewards")).toBeNull(); // 'jal' inside 'Kajal' → JAL Mileage Bank
  });
  it("matchProgram_detects_substring_false_positive_united", () => {
    expect(matchProgram("United Colors of Benetton Rewards")).toBeNull(); // → United MileagePlus
  });
  it("matchProgram_detects_substring_false_positive_virgin_and_thai", () => {
    expect(matchProgram("Virgin Mobile Rewards")).toBeNull(); // → Virgin Atlantic
    expect(matchProgram("Thailand Tourism Card")).toBeNull();  // → Thai Royal Orchid
  });
  it("matchProgram_detects_compact_spelling_Miles&More", () => {
    expect(matchProgram("Miles&More")).toBe("miles_and_more"); // currently null
  });
  it("matchProgram_detects_compact_spelling_FlyingBlue", () => {
    expect(matchProgram("FlyingBlue")).toBe("flying_blue"); // currently null
  });
  it("matchProgram_detects_nbsp_and_double_space_in_Miles_and_More", () => {
    expect(matchProgram("Miles & More")).toBe("miles_and_more");
    expect(matchProgram("Miles  &  More")).toBe("miles_and_more");
  });
  it("matchProgram_detects_null_name_crash", () => {
    // loyalty_accounts.program_name could be null from the DB; should answer null, not throw
    expect(matchProgram(null as unknown as string)).toBeNull();
    expect(matchProgram(undefined as unknown as string)).toBeNull();
  });
});

describe("pathsTo ranks at the amount being shown", () => {
  it("pathsTo_detects_ranking_flip_when_bonus_block_changes_the_winner", () => {
    // Direct 5:2 (40,000 at 1L) vs Marriott 1:1 → Aeroplan (38,333 at 1L, but 75,000 vs 72,000 at 1.8L).
    const s = synth([
      { program: "aeroplan", ratio: { from: 5, to: 2 } },
      { program: "marriott", ratio: { from: 1, to: 1 } },
    ]);
    for (const amount of [100_000, 180_000]) {
      const paths = pathsTo(s, "aeroplan", amount);
      const top = convertAlong(amount, paths[0], s);
      const max = Math.max(...paths.map((p) => convertAlong(amount, p, s)));
      expect(top, `top path at ${amount}`).toBe(max);
    }
    expect(pathsTo(s, "aeroplan", 100_000)[0].hops).toHaveLength(1);
    expect(pathsTo(s, "aeroplan", 180_000)[0].hops).toHaveLength(2);
  });
  it("no amount, 0 or junk falls back to ranking at 1,00,000", () => {
    const s = synth([
      { program: "aeroplan", ratio: { from: 5, to: 2 } },
      { program: "marriott", ratio: { from: 1, to: 1 } },
    ]);
    for (const a of [undefined, 0, -5, NaN]) expect(pathsTo(s, "aeroplan", a)[0].hops, String(a)).toHaveLength(1);
  });
});

// ── Guards: these held from the start ───────────────────────────────────────
describe("convert: boundaries and exactness", () => {
  it("floors, never rounds up, at every .5 and .999 case", () => {
    expect(convert(3, { from: 2, to: 1 })).toBe(1);        // 1.5
    expect(convert(1, { from: 3, to: 2 })).toBe(0);        // 0.66
    expect(convert(2, { from: 3, to: 2 })).toBe(1);        // 1.33
    expect(convert(299, { from: 3, to: 1 })).toBe(99);     // 99.67
    expect(convert(1999.999, { from: 1, to: 1 })).toBe(1999);
    expect(convert(0.999999999, { from: 1, to: 1000 })).toBe(0); // floors BEFORE multiplying
  });

  it("returns +0 (not -0) for every zero outcome", () => {
    for (const n of [convert(0.5, { from: 1, to: 1 }), convert(-0, { from: 1, to: 1 }), convert(-0.5, { from: 1, to: 1 })]) {
      expect(Object.is(n, 0)).toBe(true);
    }
  });

  it("matches an exact BigInt reference for every integer in a dense sweep", () => {
    const ratios = [[5, 4], [2, 1], [5, 2], [3, 1], [2, 3], [3, 2], [1, 3], [10, 3]];
    for (const [f, t] of ratios) {
      for (let p = 0; p <= 20_000; p++) {
        const want = Number((BigInt(p) * BigInt(t)) / BigInt(f));
        if (convert(p, { from: f, to: t }) !== want) throw new Error(`${p} @ ${f}:${t}`);
      }
    }
    for (const base of [10 ** 9, 10 ** 12]) {
      for (let k = 0; k < 500; k++) {
        const p = base + k;
        for (const [f, t] of ratios) {
          const want = Number((BigInt(p) * BigInt(t)) / BigInt(f));
          if (convert(p, { from: f, to: t }) !== want) throw new Error(`${p} @ ${f}:${t}`);
        }
      }
    }
  });

  it("is monotonic: more points never yield fewer partner units (Marriott bonus cliff included)", () => {
    const m = { from: 3, to: 1 }, bonus = { per: 60000, extra: 5000 };
    let prev = -1;
    for (let p = 0; p <= 250_000; p += 7) {
      const v = convert(p, m, bonus);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("Marriott bonus: block boundary at exactly 60,000, zero blocks below, 1,00,000 = 1 block", () => {
    const m = { from: 3, to: 1 }, bonus = { per: 60000, extra: 5000 };
    expect(convert(1, m, bonus)).toBe(0);
    expect(convert(59_999, m, bonus)).toBe(19_999);
    expect(convert(60_000, m, bonus)).toBe(25_000);
    expect(convert(60_001, m, bonus)).toBe(25_000);
    expect(convert(100_000, m, bonus)).toBe(38_333);   // 33,333 + 5,000 (one block, not 1.67)
    expect(convert(179_999, m, bonus)).toBe(59_999 + 10_000);
    expect(convert(180_000, m, bonus)).toBe(60_000 + 15_000);
  });

  it("bonus does not apply on junk input, and is not applied to a zero balance", () => {
    const bonus = { per: 60000, extra: 5000 };
    for (const bad of [0, -60000, NaN, Infinity, 0.9]) {
      expect(convert(bad, { from: 3, to: 1 }, bonus), String(bad)).toBe(0);
    }
  });

  it("a 'bonus' of undefined or extra 0 changes nothing", () => {
    expect(convert(120000, { from: 3, to: 1 }, undefined)).toBe(40000);
    expect(convert(120000, { from: 3, to: 1 }, { per: 60000, extra: 0 })).toBe(40000);
  });

  it("NaN ratio fields give 0", () => {
    expect(convert(1000, { from: NaN, to: 1 })).toBe(0);
    expect(convert(1000, { from: 1, to: NaN })).toBe(0);
    expect(convert(1000, { from: Infinity, to: 1 })).toBe(0);
  });
});

describe("usablePoints: boundaries", () => {
  const hdfc = { min: 1000, increment: 1000 };
  it("min-1, min, min+1 and increment edges", () => {
    expect(usablePoints(999, hdfc)).toBe(0);
    expect(usablePoints(1000, hdfc)).toBe(1000);
    expect(usablePoints(1001, hdfc)).toBe(1000);
    expect(usablePoints(1999.999, hdfc)).toBe(1000);
    expect(usablePoints(999.9999999, hdfc)).toBe(0);
    expect(usablePoints(2000, hdfc)).toBe(2000);
  });
  it("the min is checked AFTER rounding down to the multiple", () => {
    expect(usablePoints(1999, { min: 2000, increment: 1000 })).toBe(0);
    expect(usablePoints(2999, { min: 2000, increment: 1000 })).toBe(2000);
  });
  it("increment larger than the balance gives 0, not negative", () => {
    expect(usablePoints(500, { increment: 1000 })).toBe(0);
  });
  it("increment 0 / 1 / undefined are all pass-through", () => {
    for (const increment of [0, 1, undefined]) expect(usablePoints(1234, { increment })).toBe(1234);
  });
  it("is idempotent and never increases the input", () => {
    for (const s of [hdfc, { min: 1000 }, undefined]) {
      for (let p = 0; p < 5000; p += 13) {
        const u = usablePoints(p, s);
        expect(u).toBeLessThanOrEqual(p);
        expect(usablePoints(u, s)).toBe(u);
      }
    }
  });
  it("bad input is 0 (Infinity too)", () => {
    for (const bad of [NaN, Infinity, -Infinity, -0, 0, -1, Number.MIN_VALUE, 0.99]) {
      expect(usablePoints(bad, hdfc), String(bad)).toBe(0);
      expect(usablePoints(bad), String(bad)).toBe(0);
    }
  });
});

describe("parsePointsInput: what a typed string becomes", () => {
  it("accepts Indian and plain grouping, rejects what Number() would wrongly accept", () => {
    expect(parsePointsInput("1,00,000")).toBe(100000);
    expect(parsePointsInput("1 00 000")).toBe(100000);
    expect(parsePointsInput(" 100000 ")).toBe(100000);
    for (const bad of ["1e5", "0x10", "", "-500", "12abc", "١٠٠٠٠", "Infinity"]) {
      expect(parsePointsInput(bad), bad).toBe(0);
    }
  });
  it("an absurdly long number is 0, not Infinity", () => {
    expect(parsePointsInput("9".repeat(400))).toBe(0);
    expect(parsePointsInput("9".repeat(20))).toBe(0);
  });
});

describe("pathsTo / convertAlong / bestPath: structure on real data", () => {
  const all = Object.values(TRANSFER_SPECS);
  const targets = Object.keys(PROGRAMS) as ProgramKey[];

  it("never more than two hops; hop 1 is a real direct partner; hop 2 is a catalog bridge", () => {
    for (const s of all) for (const t of targets) for (const p of pathsTo(s, t)) {
      expect(p.hops.length === 1 || p.hops.length === 2, `${s.product_key}→${t}`).toBe(true);
      expect(s.partners.some((x) => x.program === p.hops[0].program && x.ratio === p.hops[0].ratio)).toBe(true);
      expect(p.hops.at(-1)!.program).toBe(t);
      if (p.hops.length === 2) {
        expect(BRIDGES.some((b) => b.from === p.hops[0].program && b.to === t)).toBe(true);
        expect(p.hops[0].bonus, "no bonus on a card's own first hop").toBeUndefined();
      }
    }
  });

  it("never loops through the target, and never repeats a route", () => {
    for (const s of all) for (const t of targets) {
      const keys = pathsTo(s, t).map((p) => p.hops.map((h) => h.program).join(">"));
      expect(new Set(keys).size, `${s.product_key}→${t}`).toBe(keys.length);
      for (const p of pathsTo(s, t)) expect(p.hops[0].program === t && p.hops.length === 2).toBe(false);
    }
  });

  it("a card's non-partner airlines are never reached by chaining two bridges (Aeroplan → Miles & More)", () => {
    for (const s of all) expect(pathsTo(s, "miles_and_more").every((p) => p.hops.length === 1)).toBe(true);
    // Avios hop is one step only: Infinia → Finnair → Iberia, never Finnair → Qatar → Iberia
    for (const p of pathsTo(spec("hdfc_infinia"), "iberia")) expect(p.hops).toHaveLength(2);
  });

  it("paths[0] is truly best at a spread of balances, for every real card and target", () => {
    const amounts = [1_000, 5_000, 10_000, 59_999, 60_000, 100_000, 119_999, 120_000, 150_000, 180_000, 250_000, 1_000_000];
    for (const s of all) for (const t of targets) {
      if (pathsTo(s, t).length < 2) continue;
      for (const a of amounts) {
        const ps = pathsTo(s, t, a);
        const top = convertAlong(a, ps[0], s);
        const max = Math.max(...ps.map((p) => convertAlong(a, p, s)));
        expect(top, `${s.product_key}→${t} @${a}`).toBe(max);
      }
    }
  });

  it("junk balances give 0 down any path", () => {
    for (const s of all) for (const t of targets) for (const p of pathsTo(s, t)) {
      for (const bad of [0, -1, NaN, Infinity, 0.5, 1]) {
        const v = convertAlong(bad, p, s);
        expect(Number.isFinite(v) && v >= 0, `${s.product_key}→${t} ${bad}`).toBe(true);
      }
    }
  });

  it("is monotonic in balance along every real path (no cliff that pays less for more)", () => {
    for (const s of all) for (const t of targets) for (const p of pathsTo(s, t)) {
      let prev = -1;
      for (let a = 0; a <= 400_000; a += 997) {
        const v = convertAlong(a, p, s);
        expect(v, `${s.product_key}→${t} @${a}`).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
  });

  it("Marriott bonus counts Marriott points, not card points (2:1 card, United bridge)", () => {
    const s = synth([{ program: "marriott", ratio: { from: 2, to: 1 } }], { min: 1000, increment: 1000 });
    const [p] = pathsTo(s, "united");
    expect(p.hops.map((h) => h.program)).toEqual(["marriott", "united"]);
    // 119,999 card pts -> 119,000 usable -> 59,500 Marriott: NOT a full 60,000 block yet
    expect(convertAlong(119_999, p, s)).toBe(19_833);
    // 1,20,000 card pts -> 60,000 Marriott -> full block: 20,000 + 10,000 (United's bonus)
    expect(convertAlong(120_000, p, s)).toBe(30_000);
    expect(convertAlong(0, p, s)).toBe(0);
    // American has no bonus at the same boundary
    const [aa] = pathsTo(s, "aadvantage");
    expect(convertAlong(120_000, aa, s)).toBe(20_000);
  });

  it("floors at EVERY hop, not once at the end", () => {
    // 5:4 then 1:1 Avios then 1:1: 1,001 Axis-style pts → 800.8 → 800
    const s = synth([{ program: "finnair", ratio: { from: 5, to: 4 } }]);
    const [p] = pathsTo(s, "iberia");
    expect(convertAlong(1001, p, s)).toBe(800);
    // two flooring hops: 2:1 then 3:1 on 7 points = floor(3.5)=3 → floor(1)=1 (vs floor(7/6)=1 same); use 5 → 2 → 0
    const s2 = synth([{ program: "marriott", ratio: { from: 2, to: 1 } }]);
    const [q] = pathsTo(s2, "aadvantage");
    expect(convertAlong(5, q, s2)).toBe(0);     // 2 Marriott → 0 AA
    expect(convertAlong(17, q, s2)).toBe(2);    // 8 → 2 (a single floor of 17/6 would also be 2)
    expect(convertAlong(11, q, s2)).toBe(1);    // 5 → 1
  });

  it("an increment-restricted card rounds BEFORE the first hop only", () => {
    const s = spec("hdfc_infinia");
    const [p] = pathsTo(s, "krisflyer");
    expect(convertAlong(999, p, s)).toBe(0);
    expect(convertAlong(1000, p, s)).toBeGreaterThan(0);
    expect(convertAlong(1999, p, s)).toBe(convertAlong(1000, p, s));
  });

  it("bestPath: cards with no route are skipped, ties keep the first card, shorter path wins a tie", () => {
    const a = synth([{ program: "krisflyer", ratio: { from: 1, to: 1 } }], { product_key: "a" });
    const b = synth([{ program: "krisflyer", ratio: { from: 1, to: 1 } }], { product_key: "b" });
    expect(bestPath([a, b], "krisflyer")?.product_key).toBe("a");
    expect(bestPath([b, a], "krisflyer")?.product_key).toBe("b");
    expect(bestPath([spec("hdfc_swiggy"), a], "krisflyer")?.product_key).toBe("a");
    const viaBridge = synth([{ program: "finnair", ratio: { from: 1, to: 1 } }], { product_key: "bridge" });
    const direct = synth([{ program: "iberia", ratio: { from: 1, to: 1 } }], { product_key: "direct" });
    expect(bestPath([viaBridge, direct], "iberia")?.product_key).toBe("direct");
    expect(bestPath([direct, viaBridge], "iberia")?.product_key).toBe("direct");
  });

  it("pathsTo does not mutate the shared spec or BRIDGES (sort is on a fresh array)", () => {
    const before = JSON.stringify([TRANSFER_SPECS, BRIDGES]);
    for (const s of all) for (const t of targets) pathsTo(s, t);
    expect(JSON.stringify([TRANSFER_SPECS, BRIDGES])).toBe(before);
  });

  it("empty partner list gives no paths", () => {
    expect(pathsTo(synth([]), "krisflyer")).toEqual([]);
  });
});

describe("strength: thresholds", () => {
  it("is exact at every cutoff and one step either side", () => {
    expect(strength({ from: 100, to: 100 })).toBe("strong");
    expect(strength({ from: 101, to: 100 })).toBe("good");
    expect(strength({ from: 4, to: 3 })).toBe("good");      // 0.75 exactly
    expect(strength({ from: 5, to: 3 })).toBe("fair");      // 0.6
    expect(strength({ from: 2, to: 1 })).toBe("fair");      // 0.5 exactly
    expect(strength({ from: 201, to: 100 })).toBe("weak");  // just under 0.5
    expect(strength({ from: 5, to: 2 })).toBe("weak");
  });
  it("agrees with every real ratio's convert() ordering (higher rate never grades lower)", () => {
    const order = { weak: 0, fair: 1, good: 2, strong: 3 };
    const ratios = Object.values(TRANSFER_SPECS).flatMap((s) => s.partners.map((p) => p.ratio));
    for (const a of ratios) for (const b of ratios) {
      if (a.to / a.from > b.to / b.from) expect(order[strength(a)]).toBeGreaterThanOrEqual(order[strength(b)]);
    }
  });
});

describe("matchProgram: edges that already behave", () => {
  it("is case-, whitespace- and padding-tolerant", () => {
    expect(matchProgram("  KRISFLYER  ")).toBe("krisflyer");
    expect(matchProgram("marriott\nbonvoy")).toBe("marriott");
  });
  it("whitespace-only, punctuation-only, emoji and RTL give null", () => {
    for (const s of [" ", "\t\n", "---", "✈️🌍", "مرحبا", "航空"]) expect(matchProgram(s), s).toBeNull();
  });
  it("very long input stays fast and correct", () => {
    expect(matchProgram("x".repeat(100_000) + " Hilton Honors")).toBe("hilton");
    expect(matchProgram("x".repeat(100_000))).toBeNull();
  });
  it("longest alias wins across overlapping programs", () => {
    expect(matchProgram("Air India Flying Returns")).toBe("air_india");
    expect(matchProgram("Virgin Atlantic Flying Club")).toBe("virgin");
    expect(matchProgram("Turkish Airlines Miles & Smiles")).toBe("turkish");
    expect(matchProgram("Club ITC")).toBe("club_itc");
  });
  it("no two programs share an alias, so ties can't depend on iteration order", () => {
    const seen = new Map<string, string>();
    for (const p of Object.values(PROGRAMS)) for (const a of p.aliases) {
      expect(seen.has(a), `alias '${a}' on ${p.key} and ${seen.get(a)}`).toBe(false);
      seen.set(a, p.key);
      expect(a, `alias must be lower-case: ${a}`).toBe(a.toLowerCase());
      expect(a.trim().length, `empty alias on ${p.key}`).toBeGreaterThan(0);
    }
  });
});

describe("twoStepOptions: which bridge chains get listed", () => {
  it("lists Infinia → Finnair → Qatar/BA Avios because it beats Infinia's direct 2:1", () => {
    const opts = twoStepOptions(spec("hdfc_infinia"));
    const targets = opts.map((p) => p.hops[1].program);
    expect(targets).toContain("qatar_avios");
    expect(targets).toContain("ba_avios");
    for (const p of opts.filter((x) => x.hops[1].program === "qatar_avios")) {
      expect(p.hops[0].program).toBe("finnair");
    }
  });

  it("hides a non-direct chain that keeps under 30% (2:1 into Marriott, 3:1 out), shows one that keeps more", () => {
    const poor = synth([{ program: "marriott", ratio: { from: 2, to: 1 } }]);
    expect(twoStepOptions(poor).map((p) => p.hops[1].program)).not.toContain("aadvantage"); // 16,666 per 1L
    const fair = synth([{ program: "marriott", ratio: { from: 1, to: 1 } }]);
    expect(twoStepOptions(fair).map((p) => p.hops[1].program)).toContain("aadvantage");     // 33,333 per 1L
  });

  it("a listed chain to a direct partner always strictly beats going direct, on every real card", () => {
    for (const s of Object.values(TRANSFER_SPECS)) {
      for (const p of twoStepOptions(s)) {
        expect(p.hops).toHaveLength(2);
        const direct = pathsTo(s, p.hops[1].program).find((x) => x.hops.length === 1);
        if (direct) expect(convertAlong(100_000, p, s)).toBeGreaterThan(convertAlong(100_000, direct, s));
      }
    }
  });

  it("is sorted best first at the amount given", () => {
    for (const s of Object.values(TRANSFER_SPECS)) for (const a of [10_000, 100_000, 250_000]) {
      const units = twoStepOptions(s, a).map((p) => convertAlong(a, p, s));
      expect(units, `${s.product_key} @${a}`).toEqual([...units].sort((x, y) => y - x));
    }
  });
});
