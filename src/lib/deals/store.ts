// Deciding how a newly read deal lands in the `deals` table: a brand-new row,
// or another sighting of an offer already stored. Pure, so the daily job and
// its tests agree on exactly one rule (ARCH-04).

import { dedupKey, findMergeTarget } from "./score";
import type { DealSource, ExtractedDeal, StoredDeal } from "./types";

export type NewDealRow = Omit<StoredDeal, "id">;

export type UpsertPlan =
  | { action: "insert"; row: NewDealRow }
  | { action: "update"; id: string; row: StoredDeal }
  | { action: "unchanged"; id: string };

const earlier = (a: string, b: string) => (Date.parse(a) <= Date.parse(b) ? a : b);
const later = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);

export function planUpsert(d: ExtractedDeal, source: DealSource, existing: StoredDeal[]): UpsertPlan {
  const key = dedupKey(d);
  const target = existing.find((e) => e.dedup_key === key) ?? findMergeTarget(d, source.seen_at, existing);
  if (!target) {
    return {
      action: "insert",
      row: { ...d, dedup_key: key, sources: [source], first_seen_at: source.seen_at, last_seen_at: source.seen_at },
    };
  }
  if (target.sources.some((s) => s.kind === source.kind && s.item_id === source.item_id)) {
    return { action: "unchanged", id: target.id };
  }
  // Fill gaps from the new sighting (a blog post's missing end date, say),
  // but never overwrite a fact the stored row already has. An email's quote
  // outranks a blog's, so evidence is only replaced when the stored one
  // couldn't be verified and the new one can.
  const better = !target.evidence_verified && d.evidence_verified;
  const merged: StoredDeal = {
    ...target,
    // Adopt a transfer source the stored row lacked (only when it had none,
    // so findMergeTarget's agreement check can't be undone here).
    ...(target.from_bank ?? target.from_program ?? target.from_other
      ? {}
      : { from_bank: d.from_bank, from_program: d.from_program, from_other: d.from_other }),
    bonus_pct: target.bonus_pct ?? d.bonus_pct,
    discount_pct: target.discount_pct ?? d.discount_pct,
    starts_on: target.starts_on ?? d.starts_on,
    ends_on: target.ends_on ?? d.ends_on,
    targeted: target.targeted || d.targeted,
    evidence: better ? d.evidence : target.evidence,
    evidence_verified: target.evidence_verified || d.evidence_verified,
    headline: better ? d.headline : target.headline,
    sources: [...target.sources, source],
    first_seen_at: earlier(target.first_seen_at, source.seen_at),
    last_seen_at: later(target.last_seen_at, source.seen_at),
  };
  // A filled-in figure or date changes the row's identity.
  merged.dedup_key = dedupKey(merged);
  return { action: "update", id: target.id, row: merged };
}
