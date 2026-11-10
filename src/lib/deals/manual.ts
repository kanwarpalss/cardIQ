// Deals KP adds himself (Rewards → Live deals → "Add a deal"), for offers the
// daily job can't see: an app-only promo, a WhatsApp tip, a targeted offer on
// a program's own site.
//
// They live in the same `deals` table as found ones, so they're scored, ranked
// and graded exactly the same way (score.ts), and when the job later finds the
// same offer in an email it merges into this row instead of listing it twice.
// What marks a row as his: its source has kind "manual".

import { PROGRAMS, type ProgramKey } from "@/lib/transfer-partners/programs";
import { dedupKey } from "./score";
import type { BankKey, DealSource, ExtractedDeal, StoredDeal } from "./types";

export const BANK_NAMES: Record<BankKey, string> = {
  axis: "Axis", hdfc: "HDFC", hsbc: "HSBC", icici: "ICICI", amex: "Amex",
};

export type ManualDealInput = {
  kind: "buy_points" | "transfer_bonus";
  program: ProgramKey | "";
  /** Transfer bonuses only: whose points get the bonus. */
  fromBank: BankKey | "";
  /** Points sales only: "50% bonus" or "50% off". Transfer bonuses are always a bonus. */
  measure: "bonus" | "discount";
  /** As typed: "45", "45%", " 45 ". */
  pct: string;
  /** YYYY-MM-DD, or "" when there's no end date. */
  endsOn: string;
  link: string;
  note: string;
};

export const EMPTY_MANUAL_DEAL: ManualDealInput = {
  kind: "buy_points", program: "", fromBank: "", measure: "bonus", pct: "", endsOn: "", link: "", note: "",
};

/** What gets inserted (plus user_id): a `deals` row without its id. */
export type ManualDealRow = Omit<StoredDeal, "id">;

/** Database limits (migration 024): bonus 0 < x ≤ 300, discount 0 < x < 100. */
const MAX_BONUS = 300;

export function buildManualDeal(
  input: ManualDealInput, nowIso: string, today: string, itemId: string,
): { ok: true; row: ManualDealRow } | { ok: false; error: string } {
  if (!input.program || !(input.program in PROGRAMS)) return { ok: false, error: "Pick the program." };
  const program = input.program as ProgramKey;
  if (input.kind === "transfer_bonus" && !input.fromBank) return { ok: false, error: "Pick whose points get the bonus." };

  const raw = input.pct.trim().replace(/\s*%$/, "");
  const pct = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  const discount = input.kind === "buy_points" && input.measure === "discount";
  if (!Number.isFinite(pct) || pct <= 0) return { ok: false, error: "Enter the percentage as a number, like 45." };
  if (discount && pct >= 100) return { ok: false, error: "A discount has to be under 100%." };
  if (!discount && pct > MAX_BONUS) return { ok: false, error: `A bonus over ${MAX_BONUS}% looks like a typo.` };

  const endsOn = input.endsOn.trim();
  if (endsOn && !/^\d{4}-\d{2}-\d{2}$/.test(endsOn)) return { ok: false, error: "That end date isn't a valid date." };
  if (endsOn && endsOn < today) return { ok: false, error: "That end date has already passed." };

  const link = input.link.trim();
  if (link && !/^https?:\/\/\S+$/i.test(link)) return { ok: false, error: "The link should start with https://" };

  const p = PROGRAMS[program];
  const fromBank = input.kind === "transfer_bonus" ? (input.fromBank as BankKey) : null;
  const headline = fromBank
    ? `${BANK_NAMES[fromBank]} to ${p.name}: ${pct}% transfer bonus`
    : discount
      ? `${p.name}: ${pct}% off buying ${p.unit}`
      : `${p.name}: ${pct}% bonus on bought ${p.unit}`;

  const deal: ExtractedDeal = {
    kind: input.kind, program, from_bank: fromBank, from_program: null, from_other: null,
    bonus_pct: discount ? null : pct, discount_pct: discount ? pct : null,
    starts_on: null, ends_on: endsOn || null, targeted: false,
    headline, evidence: input.note.trim(),
    // His own words, not a quote to verify against a source.
    evidence_verified: true,
  };
  const source: DealSource = { kind: "manual", item_id: itemId, origin: "You", title: headline, url: link || null, seen_at: nowIso };
  return { ok: true, row: { ...deal, dedup_key: dedupKey(deal), sources: [source], first_seen_at: nowIso, last_seen_at: nowIso } };
}

/** Only rows nothing but KP vouches for can be deleted from the screen —
 *  once the job has found the same offer, deleting would erase its evidence. */
export function isManualOnly(d: Pick<StoredDeal, "sources">): boolean {
  return d.sources.length > 0 && d.sources.every((s) => s.kind === "manual");
}
