// Transfer search: "which of my cards reach Marriott, at what ratio, and
// what would my balance become?" — or the same question for a card.
//
// Pure functions behind the search box on Rewards → Transfer partners.
// Ratios, paths and conversions all come from math.ts (pathsTo,
// convertAlong, twoStepOptions), so the search can never disagree with the
// calculator or the grid.

import { PROGRAMS, type ProgramKey } from "./programs";
import type { CardTransfer, TransferSpec } from "./cards";
import { convertAlong, pathsTo, rate, RANK_AT, twoStepOptions, usablePoints, type Path } from "./math";

/** One physical card: each has its own statement balance. */
export type SearchCard = {
  id: string;
  product_key: string;
  short: string;
  name: string;
  issuer: string;
  last4: string;
  spec: TransferSpec;
  balance: { amount: number; as_of: string; fromStatement: boolean } | null;
};

export type Holding = { balance: number; as_of: string; auto: boolean };

export type Group = "hotel" | "airline" | "avios";
export const GROUP_LABEL: Record<Group, string> = { hotel: "Hotels", airline: "Airlines", avios: "Avios programs" };

export type Suggestion =
  | { kind: "card"; product_key: string; label: string; sub: string }
  | { kind: "program"; program: ProgramKey; label: string; sub: string }
  | { kind: "group"; group: Group; label: string; sub: string };

export type Selection = { products: string[]; programs: ProgramKey[]; groups: Group[] };
export const EMPTY_SELECTION: Selection = { products: [], programs: [], groups: [] };

const words = (s: string) => s.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Every typed word must start some word of the haystack ("mar bon" → Marriott Bonvoy). */
export function matchesQuery(haystack: string, query: string): boolean {
  const q = words(query);
  if (!q.length) return false;
  const hay = words(haystack);
  const squeezed = haystack.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return q.every((w) => hay.some((h) => h.startsWith(w)) || (w.length >= 4 && squeezed.includes(w)));
}

const inGroup = (k: ProgramKey, g: Group) =>
  g === "avios" ? PROGRAMS[k].unit === "Avios" : g === "hotel" ? PROGRAMS[k].kind === "hotel" : PROGRAMS[k].kind === "airline";

/** Programs any of the cards can reach, directly or through a bridge. */
export function reachablePrograms(cards: SearchCard[]): Set<ProgramKey> {
  const out = new Set<ProgramKey>();
  for (const c of cards) {
    for (const t of c.spec.partners) out.add(t.program);
    for (const p of twoStepOptions(c.spec)) out.add(p.hops[p.hops.length - 1].program);
  }
  return out;
}

/** Suggestions for the search box: KP's cards first, then reachable
 *  programs, then other catalog programs, then the group shortcuts. */
export function suggest(query: string, cards: SearchCard[], sel: Selection, max = 8): Suggestion[] {
  if (!words(query).length) return [];
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const c of cards) {
    if (seen.has(c.product_key) || sel.products.includes(c.product_key)) continue;
    const hay = `${c.short} ${c.name} ${c.issuer} ${cards.filter((x) => x.product_key === c.product_key).map((x) => x.last4).join(" ")}`;
    if (!matchesQuery(hay, query)) continue;
    seen.add(c.product_key);
    const n = c.spec.partners.length;
    out.push({ kind: "card", product_key: c.product_key, label: c.name, sub: n ? `Your card · ${n} partners` : "Your card · no transfer partners" });
  }
  const reach = reachablePrograms(cards);
  const programs = (Object.keys(PROGRAMS) as ProgramKey[])
    .filter((k) => !sel.programs.includes(k))
    .filter((k) => { const p = PROGRAMS[k]; return matchesQuery(`${p.name} ${p.code} ${p.unit} ${p.aliases.join(" ")}`, query); })
    .sort((a, b) => Number(reach.has(b)) - Number(reach.has(a)) || PROGRAMS[a].name.localeCompare(PROGRAMS[b].name));
  for (const k of programs) {
    out.push({ kind: "program", program: k, label: PROGRAMS[k].name, sub: reach.has(k) ? `Partner · ${PROGRAMS[k].unit}` : "None of your cards reach it" });
  }
  for (const g of Object.keys(GROUP_LABEL) as Group[]) {
    if (!sel.groups.includes(g) && matchesQuery(`${GROUP_LABEL[g]} ${g}`, query)) {
      out.push({ kind: "group", group: g, label: GROUP_LABEL[g], sub: "Show every partner of this kind" });
    }
  }
  return out.slice(0, max);
}

export type ComboRow = {
  card: SearchCard;
  program: ProgramKey;
  path: Path;
  /** The card's own listing for the first hop (time, caps, disputes). */
  first: CardTransfer;
  /** What the card's saved balance becomes; null with no balance. */
  units: number | null;
  /** How much of the balance the bank will actually move (minimums and
   *  multiple-of rules, e.g. HDFC's blocks of 1,000); null with no balance. */
  usable: number | null;
  /** What RANK_AT card points become — the example when there's no balance. */
  sample: number;
};

export type SearchResult = {
  rows: ComboRow[];
  /** Explicitly searched programs a card can't reach at all. */
  unreachable: { card: SearchCard; program: ProgramKey }[];
};

/**
 * All card × program combinations the selection asks about. Cards: the
 * selected products (each physical card separately), or all. Programs: the
 * selected ones, else every partner of the selected cards, narrowed by
 * groups. Each combination uses its single best path at the card's balance.
 */
export function searchCombos(sel: Selection, cards: SearchCard[]): SearchResult {
  const pool = sel.products.length ? cards.filter((c) => sel.products.includes(c.product_key)) : cards;
  let targets: ProgramKey[];
  if (sel.programs.length) targets = sel.programs;
  else if (sel.products.length || sel.groups.length) targets = [...reachablePrograms(pool)];
  else return { rows: [], unreachable: [] };
  if (sel.groups.length) targets = targets.filter((k) => sel.groups.some((g) => inGroup(k, g)));

  const rows: ComboRow[] = [];
  const unreachable: SearchResult["unreachable"] = [];
  for (const card of pool) {
    for (const program of targets) {
      const amount = card.balance?.amount;
      const path = pathsTo(card.spec, program, amount)[0];
      if (!path) {
        if (sel.programs.includes(program)) unreachable.push({ card, program });
        continue;
      }
      const first = card.spec.partners.find((t) => t.program === path.hops[0].program)!;
      rows.push({
        card, program, path, first,
        units: amount != null ? convertAlong(amount, path, card.spec) : null,
        usable: amount != null ? usablePoints(amount, card.spec) : null,
        sample: convertAlong(RANK_AT, path, card.spec),
      });
    }
  }
  // Searching a program: most miles first (a real balance beats an example).
  // Searching a card: best ratio first, then name.
  rows.sort((a, b) => {
    if (sel.programs.length) {
      return (b.units ?? -1) - (a.units ?? -1) || b.sample - a.sample || a.card.short.localeCompare(b.card.short);
    }
    return a.card.short.localeCompare(b.card.short)
      || b.sample - a.sample
      || PROGRAMS[a.program].name.localeCompare(PROGRAMS[b.program].name);
  });
  return { rows, unreachable };
}

/** Partner units per card point along a path (5:4 then 1:1 → 0.8). */
export const pathRate = (p: Path) => p.hops.reduce((r, h) => r * rate(h.ratio), 1);
