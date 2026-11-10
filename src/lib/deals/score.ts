// How good is a stored deal for KP, today? Pure functions, run at read time
// against his current wallet, so adding a card re-scores every deal.
//
// Two questions, answered separately so neither hides the other:
//   1. Can he use it? — a transfer bonus only matters if one of his cards
//      reaches the program (directly, or through the named source program);
//      a points sale is open to anyone with cash.
//   2. Is it actually good? — judged against the bonuses he has seen for the
//      same program and kind over the past year. "55%" means nothing on its
//      own: for Marriott it's a peak, for Hilton a 100% sale is routine.
//      History comes from his own inbox and the blogs, not from claims we
//      can't source.

import { convertAlong, RANK_AT } from "@/lib/transfer-partners/math";
import { PROGRAMS, type ProgramKey } from "@/lib/transfer-partners/programs";
import type { TransferSpec } from "@/lib/transfer-partners/cards";
import { bankOfIssuer } from "./prefilter";
import type { BankKey, ExtractedDeal, StoredDeal } from "./types";

/** The slice of a wallet card the scorer needs (WalletCard satisfies it). */
export type ScoreCard = { product_key: string; short: string; issuer: string; spec: TransferSpec };

export type DealStatus = "active" | "ending_soon" | "no_end_date" | "ended";
export type DealReach = "yours" | "buy" | "not_yours";
export type DealGrade = "new_high" | "matches_best" | "above_usual" | "below_usual" | "first_seen";

export type RouteLine = {
  card: string;
  /** Program the card's points land in first. */
  via: ProgramKey;
  /** Program units from RANK_AT card points without the bonus; null when
   *  the second leg's ratio isn't known (program → program conversions). */
  normal: number | null;
  /** The same with the bonus applied; null when either side is unknown. */
  boosted: number | null;
};

export type Assessment = {
  status: DealStatus;
  daysLeft: number | null;
  reach: DealReach;
  /** Plain-English reason for `reach`. */
  reachNote: string;
  routes: RouteLine[];
  /** Units per unit of normal price or ratio: 55% bonus → 1.55, 50% off → 2. */
  multiplier: number | null;
  grade: DealGrade | null;
  gradeNote: string | null;
  /** From an email whose quoted offer was found in the email itself. */
  verified: boolean;
};

const DAY = 86400000;
/** How far back "the past year" of comparable deals reaches. */
export const HISTORY_DAYS = 400;
/** A deal with no end date stops showing as live this long after last seen. */
export const NO_END_STALE_DAYS = 21;
export const ENDING_SOON_DAYS = 3;

const dayNum = (iso: string) => Math.floor(Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso) / DAY);

/** 55% bonus → 1.55; 50% off → 2 (the same money buys twice the points). */
export function multiplierOf(d: Pick<ExtractedDeal, "bonus_pct" | "discount_pct">): number | null {
  if (d.discount_pct != null && d.discount_pct > 0 && d.discount_pct < 100) {
    return Math.round((100 / (100 - d.discount_pct)) * 1000) / 1000;
  }
  if (d.bonus_pct != null && d.bonus_pct > 0) return Math.round((1 + d.bonus_pct / 100) * 1000) / 1000;
  return null;
}

/** Same kind, same program, same transfer source — the deals worth comparing. */
export function comparableKey(d: Pick<ExtractedDeal, "kind" | "program" | "from_bank" | "from_program" | "from_other">): string {
  const src = d.from_bank ?? d.from_program ?? (d.from_other ? d.from_other.toLowerCase() : "-");
  return `${d.kind}|${d.program}|${src}`;
}

/** Exact identity of one offer, for the `deals` table's unique key. */
export function dedupKey(d: ExtractedDeal): string {
  return `${comparableKey(d)}|${d.bonus_pct ?? "-"}|${d.discount_pct ?? "-"}|${d.ends_on ?? "-"}`;
}

/**
 * An existing row that is the same offer seen again from another source —
 * typically an email with the end date and a blog post without it. Same
 * comparable key, same figures (or one side missing), compatible end dates,
 * first seen within 60 days. Returns null when it's a genuinely new offer.
 */
export function findMergeTarget(d: ExtractedDeal, seenAt: string, existing: StoredDeal[]): StoredDeal | null {
  const at = dayNum(seenAt);
  const agree = (a: number | string | null, b: number | string | null) => a == null || b == null || a === b;
  // A source the text didn't name ("Convert your Bonvoy points to Aeroplan
  // and get 15% more") is the same offer as one that did, if all else agrees.
  const src = (x: ExtractedDeal) => x.from_bank ?? x.from_program ?? (x.from_other ? x.from_other.toLowerCase() : null);
  for (const e of existing) {
    if (e.kind !== d.kind || e.program !== d.program || !agree(src(d), src(e))) continue;
    if (!agree(d.bonus_pct, e.bonus_pct) || !agree(d.discount_pct, e.discount_pct)) continue;
    if (d.bonus_pct == null && d.discount_pct == null && (e.bonus_pct != null || e.discount_pct != null)) continue;
    if (!agree(d.ends_on, e.ends_on)) continue;
    if (Math.abs(at - dayNum(e.first_seen_at)) > 60) continue;
    return e;
  }
  return null;
}

function statusOf(d: StoredDeal, today: string): { status: DealStatus; daysLeft: number | null } {
  const t = dayNum(today);
  if (d.ends_on) {
    const left = dayNum(d.ends_on) - t;
    if (left < 0) return { status: "ended", daysLeft: left };
    return { status: left <= ENDING_SOON_DAYS ? "ending_soon" : "active", daysLeft: left };
  }
  return t - dayNum(d.last_seen_at) > NO_END_STALE_DAYS
    ? { status: "ended", daysLeft: null }
    : { status: "no_end_date", daysLeft: null };
}

const name = (k: ProgramKey) => PROGRAMS[k].name;
const pct = (d: StoredDeal) => d.bonus_pct ?? d.discount_pct;

function routesInto(d: StoredDeal, cards: ScoreCard[], landIn: ProgramKey, bank: BankKey | null): RouteLine[] {
  const out: RouteLine[] = [];
  for (const c of cards) {
    if (bank && bankOfIssuer(c.issuer) !== bank) continue;
    const t = c.spec.partners.find((p) => p.program === landIn);
    if (!t) continue;
    const firstLeg = convertAlong(RANK_AT, { product_key: c.product_key, hops: [{ program: landIn, ratio: t.ratio }] }, c.spec);
    // Into the deal's program directly: the bonus applies to what lands.
    // Via another program: the second leg's ratio isn't in our data, so the
    // screen shows the first leg and the bonus, not an invented total.
    const direct = landIn === d.program;
    const bonus = d.bonus_pct;
    out.push({
      card: c.short,
      via: landIn,
      normal: direct ? firstLeg : null,
      boosted: direct && bonus != null ? Math.floor(firstLeg * (1 + bonus / 100)) : null,
    });
  }
  return out;
}

function reachOf(d: StoredDeal, cards: ScoreCard[]): Pick<Assessment, "reach" | "reachNote" | "routes"> {
  if (d.kind === "buy_points") {
    return { reach: "buy", reachNote: `Bought with cash, direct from ${name(d.program)}`, routes: [] };
  }
  if (d.from_other) {
    return { reach: "not_yours", reachNote: `Bonus is on ${d.from_other}, not on your cards' points`, routes: [] };
  }
  if (d.from_bank) {
    const banks = new Set(cards.map((c) => bankOfIssuer(c.issuer)));
    if (!banks.has(d.from_bank)) {
      return { reach: "not_yours", reachNote: `For ${d.from_bank.toUpperCase()} cardholders — you hold none`, routes: [] };
    }
    const routes = routesInto(d, cards, d.program, d.from_bank);
    if (!routes.length && d.kind === "transfer_bonus") {
      return { reach: "not_yours", reachNote: `Your ${d.from_bank.toUpperCase()} cards don't transfer to ${name(d.program)}`, routes };
    }
    return { reach: "yours", reachNote: d.kind === "ratio_change"
      ? `Changes your ${d.from_bank.toUpperCase()} cards' transfers — partner data may need updating`
      : `Your ${d.from_bank.toUpperCase()} points transfer to ${name(d.program)}`, routes };
  }
  if (d.from_program) {
    const routes = routesInto(d, cards, d.from_program, null);
    return routes.length
      ? { reach: "yours", reachNote: `Two steps: your points → ${name(d.from_program)} → ${name(d.program)}`, routes }
      : { reach: "not_yours", reachNote: `None of your cards transfer to ${name(d.from_program)}`, routes };
  }
  const routes = routesInto(d, cards, d.program, null);
  return routes.length
    ? { reach: "yours", reachNote: `Your cards transfer to ${name(d.program)}`, routes }
    : { reach: "not_yours", reachNote: `None of your cards transfer to ${name(d.program)}`, routes };
}

function gradeOf(d: StoredDeal, history: StoredDeal[]): Pick<Assessment, "grade" | "gradeNote"> {
  const m = multiplierOf(d);
  if (m == null) return { grade: null, gradeNote: null };
  const key = comparableKey(d);
  const at = dayNum(d.first_seen_at);
  const prior = history
    .filter((h) => h.id !== d.id && comparableKey(h) === key)
    .filter((h) => { const t = dayNum(h.first_seen_at); return t <= at && at - t <= HISTORY_DAYS; })
    .map((h) => ({ m: multiplierOf(h), h }))
    .filter((x): x is { m: number; h: StoredDeal } => x.m != null);
  if (!prior.length) return { grade: "first_seen", gradeNote: "First offer like this on record — no history to compare yet" };

  const best = prior.reduce((a, b) => (b.m > a.m ? b : a));
  const sorted = prior.map((x) => x.m).sort((a, b) => a - b);
  const median = sorted[Math.floor((sorted.length - 1) / 2)];
  const since = new Date(Math.min(...prior.map((x) => Date.parse(x.h.first_seen_at))))
    .toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
  const bestTxt = `${pct(best.h)}%${best.h.discount_pct != null ? " off" : ""}`;
  const n = prior.length;
  const seen = `${n} earlier offer${n === 1 ? "" : "s"} since ${since}`;
  if (m > best.m) return { grade: "new_high", gradeNote: `Beats the best of ${seen} (was ${bestTxt})` };
  if (m === best.m) return { grade: "matches_best", gradeNote: `Matches the best of ${seen}` };
  if (m >= median) return { grade: "above_usual", gradeNote: `Above the usual; best of ${seen} was ${bestTxt}` };
  return { grade: "below_usual", gradeNote: `Weaker than usual; best of ${seen} was ${bestTxt}` };
}

export function assessDeal(d: StoredDeal, cards: ScoreCard[], history: StoredDeal[], today: string): Assessment {
  return {
    ...statusOf(d, today),
    ...reachOf(d, cards),
    multiplier: multiplierOf(d),
    ...gradeOf(d, history),
    verified: d.evidence_verified && d.sources.some((s) => s.kind === "email" || s.kind === "manual"),
  };
}

const REACH_ORDER: Record<DealReach, number> = { yours: 0, buy: 1, not_yours: 2 };
const GRADE_ORDER: Record<DealGrade, number> = { new_high: 0, matches_best: 1, above_usual: 2, first_seen: 3, below_usual: 4 };

/** Live first; then usable-from-your-cards, then cash buys, then the rest;
 *  then strongest grade; then soonest to end. */
export function rankDeals<T extends { assessment: Assessment }>(rows: T[]): T[] {
  const live = (a: Assessment) => (a.status === "ended" ? 1 : 0);
  return [...rows].sort((x, y) => {
    const a = x.assessment, b = y.assessment;
    return live(a) - live(b)
      || REACH_ORDER[a.reach] - REACH_ORDER[b.reach]
      || (a.grade ? GRADE_ORDER[a.grade] : 5) - (b.grade ? GRADE_ORDER[b.grade] : 5)
      || (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999);
  });
}
