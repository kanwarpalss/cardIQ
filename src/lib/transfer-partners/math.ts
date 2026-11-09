// Transfer arithmetic and route finding. Pure functions — no React, no I/O —
// so every number the Transfer partners screen shows is unit-tested here.

import { PROGRAMS, BRIDGES, type Bridge, type ProgramKey, type Ratio } from "./programs";
import type { TransferSpec } from "./cards";

/** Partner units per ONE source unit (5:4 → 0.8). */
export const rate = (r: Ratio) => r.to / r.from;

/** A ratio a bank could actually apply: both sides positive, finite numbers. */
const validRatio = (r: Ratio) =>
  Number.isFinite(r.from) && Number.isFinite(r.to) && r.from > 0 && r.to > 0;

/** Card points `pathsTo` ranks at when no amount is given: a large round
 *  number, so the 60,000-point Marriott bonus counts. */
export const RANK_AT = 100000;

/** The amount to rank at: the one given, or RANK_AT when it's missing or junk. */
const rankAt = (amount?: number) =>
  amount !== undefined && Number.isFinite(amount) && amount > 0 ? amount : RANK_AT;

export const fmtRatio = (r: Ratio) => `${r.from}:${r.to}`;

export type Strength = "strong" | "good" | "fair" | "weak";

/** How generous a ratio is, judged only by partner units per source unit.
 *  1:1 or better is strong, 5:4 good, 2:1 fair, 5:2 and worse weak. */
export function strength(r: Ratio): Strength {
  // A ratio convert() refuses (zero, negative, NaN) transfers nothing.
  if (!validRatio(r)) return "weak";
  const x = rate(r);
  if (x >= 1) return "strong";
  if (x >= 0.75) return "good";
  if (x >= 0.5) return "fair";
  return "weak";
}

/** Points the program will actually accept, after its minimum and
 *  multiple-of rules. Bad input (negative, NaN, fractional) is treated as the
 *  nearest whole number of points at or below it, never below zero. */
export function usablePoints(points: number, spec?: Pick<TransferSpec, "min" | "increment">): number {
  if (!Number.isFinite(points) || points <= 0) return 0;
  let p = Math.floor(points);
  if (spec?.increment && spec.increment > 1) p -= p % spec.increment;
  if (spec?.min && p < spec.min) return 0;
  return p;
}

/** Whole partner units from one hop. Banks and programs credit whole units
 *  only, so any fraction is dropped, never rounded up. */
export function convert(points: number, ratio: Ratio, bonus?: Bridge["bonus"]): number {
  if (!Number.isFinite(points) || points <= 0) return 0;
  if (!validRatio(ratio)) return 0;
  const p = Math.floor(points);
  // Multiply before dividing: p * to is an exact integer, so an exact quotient
  // stays exact. Dividing first (p * 0.8) can land a hair under and lose a mile.
  // Past the safe-integer range that exactness is gone (and huge input can
  // overflow to Infinity), so treat it as junk like any other bad input.
  if (!Number.isSafeInteger(p * ratio.to)) return 0;
  const base = Math.floor((p * ratio.to) / ratio.from);
  // A malformed bonus (zero/negative block, NaN) is ignored, never allowed to
  // turn the result into NaN, Infinity or a deduction.
  const okBonus = bonus && Number.isFinite(bonus.per) && bonus.per > 0
    && Number.isFinite(bonus.extra) && bonus.extra > 0;
  const extra = okBonus ? Math.floor(p / bonus.per) * bonus.extra : 0;
  return base + extra;
}

export type Hop = {
  program: ProgramKey;
  ratio: Ratio;
  bonus?: Bridge["bonus"];
  /** Bridge note for hops after the first. */
  note?: string;
};

/** One way to get from a card's points to a target program. */
export type Path = { product_key: string; hops: Hop[] };

/** Every direct transfer, plus every one-bridge route, from a card's points to
 *  `target`, best first. Bridges only ever chain from a program the card
 *  reaches directly — never two bridges in a row.
 *
 *  "Best" depends on how many points move: the Marriott bonus pays per full
 *  60,000 block, so a bridge can lose at 1 lakh and win at 1.8 lakh. Pass the
 *  amount the screen is showing; with none (or 0) it ranks at RANK_AT. */
export function pathsTo(spec: TransferSpec, target: ProgramKey, amount?: number): Path[] {
  const out: Path[] = [];
  for (const t of spec.partners) {
    if (t.program === target) {
      out.push({ product_key: spec.product_key, hops: [{ program: t.program, ratio: t.ratio }] });
    }
    for (const b of BRIDGES) {
      if (b.from === t.program && b.to === target) {
        out.push({
          product_key: spec.product_key,
          hops: [
            { program: t.program, ratio: t.ratio },
            { program: b.to, ratio: b.ratio, bonus: b.bonus, note: b.note },
          ],
        });
      }
    }
  }
  const at = rankAt(amount);
  // Best = most target units at that amount; ties go to the shorter path.
  return out.sort((a, b) =>
    convertAlong(at, b, spec) - convertAlong(at, a, spec) ||
    a.hops.length - b.hops.length);
}

/** Target units from pushing `points` through every hop, flooring at each. */
export function convertAlong(points: number, path: Path, spec?: Pick<TransferSpec, "min" | "increment">): number {
  let amount = usablePoints(points, spec);
  for (const h of path.hops) amount = convert(amount, h.ratio, h.bonus);
  return amount;
}

/** The single best path from any of the given cards, or null if none reach. */
export function bestPath(specs: TransferSpec[], target: ProgramKey, amount = RANK_AT): Path | null {
  let best: Path | null = null;
  let bestUnits = -1;
  for (const s of specs) {
    const p = pathsTo(s, target, amount)[0];
    if (!p) continue;
    const units = convertAlong(amount, p, s);
    if (units > bestUnits || (units === bestUnits && best && p.hops.length < best.hops.length)) {
      best = p; bestUnits = units;
    }
  }
  return best;
}

/** Lower-case, unify odd spaces (non-breaking, tabs, runs) and the spacing
 *  around "&", so "Miles&More", "Miles  &  More" and "Miles & More" agree. */
const normName = (s: string) =>
  s.normalize("NFKC").toLowerCase().replace(/\s*&\s*/g, " & ").replace(/\s+/g, " ").trim();
/** Letters and digits only: "FlyingBlue" and "flying blue" both → "flyingblue". */
const compact = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Map a free-text loyalty program name ("KrisFlyer Singapore Airlines") to a
 *  catalog program, or null. Aliases match whole words only, so "Kajal Salon"
 *  is not JAL and "Thailand" is not Thai. Multi-word aliases also match with
 *  the spaces squeezed out ("FlyingBlue", "Miles&More"). Longest alias wins,
 *  so "miles & smiles" beats a bare "turkish"-style fragment. */
export function matchProgram(name: string | null | undefined): ProgramKey | null {
  if (typeof name !== "string") return null;
  const n = normName(name);
  const nc = compact(n);
  let hit: ProgramKey | null = null;
  let len = 0;
  for (const p of Object.values(PROGRAMS)) {
    for (const raw of p.aliases) {
      const a = normName(raw);
      if (a.length <= len) continue;
      const word = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(a)}(?![\\p{L}\\p{N}])`, "u").test(n);
      // Squeezed matching only for multi-word aliases: a short single word
      // ("jal") squeezed into "kajalsalon" is exactly the false hit to avoid.
      const squeezed = /[ &]/.test(a) && nc.includes(compact(a));
      if (word || squeezed) { hit = p.key as ProgramKey; len = a.length; }
    }
  }
  return hit;
}

/** A typed point amount ("1,00,000", "100 000", "25000") as a whole number.
 *  Anything that isn't plain digits (with optional separators) is 0, so a
 *  stray letter shows "0 miles" rather than a misleading partial number. */
export function parsePointsInput(s: string): number {
  const clean = s.replace(/[,\s_]/g, "");
  if (!/^\d+(\.\d+)?$/.test(clean)) return 0;
  const n = Math.floor(Number(clean));
  // Twenty 9s is past what a number holds exactly; 400 of them is Infinity.
  return Number.isSafeInteger(n) ? n : 0;
}

/** A two-step path that strictly beats the card's own direct transfer to
 *  `target` (e.g. Infinia → Finnair 1:1 → Qatar 1:1, versus Infinia → Qatar
 *  2:1), or null when going direct is as good or better. */
export function betterIndirect(spec: TransferSpec, target: ProgramKey, amount?: number): Path | null {
  const best = pathsTo(spec, target, amount)[0];
  // pathsTo breaks ties toward fewer hops, so a 2-hop winner is strictly better.
  return best && best.hops.length > 1 ? best : null;
}

/** Share of card points a two-step chain must keep (at RANK_AT) to be listed
 *  when there's no direct transfer to beat. Below this (e.g. a 2:1 card into
 *  Marriott, then 3:1 out to an airline) listing it would read as advice. */
export const TWO_STEP_MIN_KEEP = 0.3;

/** Programs a card reaches best through a bridge, best first: either not a
 *  direct partner at all (and the chain keeps at least TWO_STEP_MIN_KEEP), or
 *  a direct partner the two-step path strictly beats. */
export function twoStepOptions(spec: TransferSpec, amount?: number): Path[] {
  const direct = new Set(spec.partners.map((t) => t.program));
  const targets = new Set(BRIDGES.filter((b) => direct.has(b.from)).map((b) => b.to));
  const at = rankAt(amount);
  return [...targets]
    .map((k) => pathsTo(spec, k, amount)[0])
    .filter((p): p is Path => !!p && p.hops.length > 1)
    .filter((p) => direct.has(p.hops[1].program) ||
      convertAlong(RANK_AT, p, spec) >= RANK_AT * TWO_STEP_MIN_KEEP)
    .sort((a, b) => convertAlong(at, b, spec) - convertAlong(at, a, spec));
}
