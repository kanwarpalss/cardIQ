// Shapes shared by the deal finder: the daily job (scripts/find-deals.ts)
// writes Deals, the Rewards → Deals screen reads and scores them.
//
// Only FACTS are stored (what the email or post said). Whether a deal is
// reachable from KP's cards, and how good it is, is worked out at read time
// by assessDeal() — so adding or removing a card re-scores every deal
// without re-reading a single email.

import type { ProgramKey } from "@/lib/transfer-partners/programs";

/**
 * buy_points      — buy or gift a program's points/miles at a bonus or discount.
 * transfer_bonus  — extra points when moving INTO a program (from a bank,
 *                   another program, or some other currency).
 * ratio_change    — a lasting change to a bank's partner list or ratio; a
 *                   sign src/lib/transfer-partners/cards.ts may be stale.
 */
export type DealKind = "buy_points" | "transfer_bonus" | "ratio_change";

/** Banks whose points KP's cards earn. Derived from CARD_REGISTRY issuers. */
export type BankKey = "axis" | "hdfc" | "hsbc" | "icici" | "amex";

export type DealSourceKind = "email" | "blog";

/** What one email or blog post said, after validation. */
export type ExtractedDeal = {
  kind: DealKind;
  /** The program you buy into or transfer into. */
  program: ProgramKey;
  /** Transfer source when it's one of KP's banks. */
  from_bank: BankKey | null;
  /** Transfer source when it's another catalog program (KrisFlyer → Accor). */
  from_program: ProgramKey | null;
  /** Transfer source when it's anything else (Flipkart SuperCoins, HeyMax). */
  from_other: string | null;
  /** "50" for a 50% bonus. Null when the text gave no number we could verify. */
  bonus_pct: number | null;
  /** "50" for 50% off. Null when not a discount offer. */
  discount_pct: number | null;
  starts_on: string | null;
  ends_on: string | null;
  /** Personalised ("your exclusive offer") — another account may see less. */
  targeted: boolean;
  headline: string;
  /** Verbatim sentence from the source that states the offer. */
  evidence: string;
  /** False when the evidence quote could not be found in the source text. */
  evidence_verified: boolean;
};

export type DealSource = {
  kind: DealSourceKind;
  /** Gmail hex message id, or the blog post's link. */
  item_id: string;
  /** Sender address, or the blog's name. */
  origin: string;
  title: string;
  url: string | null;
  /** ISO timestamp the email arrived / the post was published. */
  seen_at: string;
};

/** One row of the `deals` table. */
export type StoredDeal = ExtractedDeal & {
  id: string;
  dedup_key: string;
  sources: DealSource[];
  first_seen_at: string;
  last_seen_at: string;
};

/** One row of `deal_runs` — the job's own health record. */
export type DealRun = {
  started_at: string;
  finished_at: string | null;
  ok: boolean;
  /** Plain-English stats or the error message. */
  summary: string;
};
