// The pure half of `npm run deals:status` (scripts/deals-status.ts): turns
// the deal finder's tables into a compact, labelled read-out, so agents check
// the job with one committed command instead of writing a throwaway probe.
// Everything here is pure; the script only fetches rows and prints.

import { CARD_REGISTRY } from "@/lib/cards/registry";
import { TRANSFER_SPECS } from "@/lib/transfer-partners/cards";
import { assessDeal, rankDeals, type Assessment, type ScoreCard } from "./score";
import type { DealRun, StoredDeal } from "./types";

export const SECTIONS = ["counts", "health", "runs", "live", "mini"] as const;
export type Section = (typeof SECTIONS)[number];

/** Shown when no section flag is given. `mini` needs ssh, so it is opt-in. */
export const DEFAULT_SECTIONS: Section[] = ["counts", "health", "runs", "live"];

export const OUTCOMES = ["deal", "not_deal", "skipped", "error"] as const;

export type StatusArgs = {
  sections: Section[];
  /** How many recent runs `--runs` lists. */
  runs: number;
  /** Include ended deals in the live list. */
  ended: boolean;
  help: boolean;
};

export const USAGE = `npm run deals:status -- [flags]      (read-only)

  (no flags)  counts + health + runs + live
  --counts    stored deals, runs, seen items by outcome
  --health    the same health line the Deals screen shows
  --runs      recent deal_runs (newest first); --runs N for N rows (default 5)
  --live      the ranked live-deal list, scored against the current wallet
  --ended     with --live: also list ended deals
  --mini      PM2 cardiq-deals settings on the Mac mini (via ssh macmini)
  --help      this text`;

/** Parse argv (after the script name). Throws on an unknown flag, so a typo
 *  never silently prints the wrong thing. */
export function parseStatusArgs(argv: string[]): StatusArgs {
  const picked = new Set<Section>();
  let runs = 5;
  let ended = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { help = true; continue; }
    if (a === "--ended") { ended = true; continue; }
    if (a === "--all") { DEFAULT_SECTIONS.forEach((s) => picked.add(s)); picked.add("mini"); continue; }
    const name = a.startsWith("--") ? a.slice(2) : "";
    if (!(SECTIONS as readonly string[]).includes(name)) throw new Error(`Unknown flag "${a}". Try --help.`);
    picked.add(name as Section);
    if (name === "runs" && argv[i + 1] !== undefined && /^\d+$/.test(argv[i + 1])) {
      const n = Number(argv[++i]);
      if (n < 1) throw new Error("--runs N needs N of at least 1.");
      runs = Math.min(n, 100);
    }
  }
  const sections = picked.size ? SECTIONS.filter((s) => picked.has(s)) : [...DEFAULT_SECTIONS];
  return { sections, runs, ended, help };
}

/** numeric columns arrive as strings from PostgREST. */
export function toStoredDeal(row: Record<string, unknown>): StoredDeal {
  return {
    ...row,
    bonus_pct: row.bonus_pct == null ? null : Number(row.bonus_pct),
    discount_pct: row.discount_pct == null ? null : Number(row.discount_pct),
  } as StoredDeal;
}

/**
 * The wallet the scorer needs, from the `cards` table's product keys: one
 * entry per product, cards without a transfer spec or registry entry left
 * out (as the Deals screen's buildWallet does) and reported, never crashed on.
 * `short` is the registry display name; the screen uses shorter labels, which
 * only changes the wording of reach notes, not reach itself.
 */
export function scoreWallet(productKeys: string[]): { cards: ScoreCard[]; skipped: string[] } {
  const cards: ScoreCard[] = [];
  const skipped: string[] = [];
  for (const k of [...new Set(productKeys)]) {
    const spec = TRANSFER_SPECS[k];
    const reg = CARD_REGISTRY[k];
    if (!spec || !reg) { skipped.push(k); continue; }
    cards.push({ product_key: k, short: reg.display_name, issuer: reg.issuer, spec });
  }
  return { cards, skipped };
}

export type OutcomeCounts = Record<(typeof OUTCOMES)[number], number>;

export function formatCounts(deals: number, runs: number, seen: OutcomeCounts): string {
  const total = OUTCOMES.reduce((s, o) => s + seen[o], 0);
  const parts = OUTCOMES.map((o) => `${o} ${seen[o]}`).join(", ");
  return `deals stored: ${deals} | deal_runs: ${runs} | seen items: ${total} (${parts})`;
}

/** "2026-11-09T10:11:12Z" → "09 Nov 2026 15:41 IST" (KP's clock). */
export function fmtIst(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return `invalid date "${iso}"`;
  const s = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(t);
  return `${s.replace(",", "")} IST`;
}

export function formatRun(r: DealRun): string {
  const state = !r.finished_at ? "UNFINISHED" : r.ok ? "ok" : "FAILED";
  const mins = r.finished_at ? (Date.parse(r.finished_at) - Date.parse(r.started_at)) / 60000 : NaN;
  const took = Number.isFinite(mins) ? ` (${mins < 1 ? "<1" : Math.round(mins)} min)` : "";
  return `${fmtIst(r.started_at)}  ${state.padEnd(10)}${took}  ${r.summary || "(no summary)"}`;
}

export type LiveRow = { d: StoredDeal; assessment: Assessment };

/** Ranked exactly as the Deals screen ranks them; ended dropped unless asked. */
export function rankLive(deals: StoredDeal[], wallet: ScoreCard[], today: string, includeEnded = false): LiveRow[] {
  const ranked = rankDeals(deals.map((d) => ({ d, assessment: assessDeal(d, wallet, deals, today) })));
  return includeEnded ? ranked : ranked.filter((r) => r.assessment.status !== "ended");
}

export function formatLiveRow({ d, assessment: a }: LiveRow): string {
  const left = a.daysLeft == null ? "" : ` ${a.daysLeft}d left`;
  const note = a.gradeNote ? ` | ${a.gradeNote}` : "";
  return `${a.reach.padEnd(9)} ${String(a.grade ?? "—").padEnd(12)} ${(a.status + left).padEnd(20)} ${d.headline}${note}`;
}
