// Pure logic for the holistic layer: reward balances, offers, loyalty tiers.
// Keep UI-free and side-effect-free — everything here is unit-tested in perks.test.ts.

import type { RewardProgram } from "./cards/types";
import { daysUntil } from "./format";

// ── Row shapes (mirror migration 009) ───────────────────────────────────────

export type RewardBalanceRow = {
  id: string;
  card_id: string;
  program: string;
  balance: number;
  as_of: string;      // YYYY-MM-DD
  notes: string | null;
  created_at: string; // ISO timestamp
};

export type OfferRow = {
  id: string;
  card_id: string | null;
  title: string;
  merchant: string | null;
  description: string | null;
  valid_from: string | null;
  valid_until: string | null; // null = no expiry (NEVER "expires today")
  source_url: string | null;
  status: "active" | "used" | "expired" | "archived";
  created_at: string;
};

export type LoyaltyRow = {
  id: string;
  program_name: string;
  program_type: "airline" | "hotel" | "other";
  member_id: string | null;
  tier: string | null;
  tier_expires_on: string | null;
  points_balance: number | null;
  points_expire_on: string | null;
  linked_card: string | null;
  notes: string | null;
  updated_at: string;
};

// ── Reward balances ──────────────────────────────────────────────────────────

/** Latest snapshot per card: as_of DESC, then created_at DESC as tiebreak. */
export function latestBalanceByCard(
  rows: RewardBalanceRow[]
): Map<string, RewardBalanceRow> {
  const latest = new Map<string, RewardBalanceRow>();
  for (const row of rows) {
    const prev = latest.get(row.card_id);
    if (
      !prev ||
      row.as_of > prev.as_of ||
      (row.as_of === prev.as_of && row.created_at > prev.created_at)
    ) {
      latest.set(row.card_id, row);
    }
  }
  return latest;
}

/** Base-rate points estimate for a spend amount. Always an estimate — label it so. */
export function estimatePoints(spendInr: number, rewards: RewardProgram): number {
  if (spendInr <= 0 || rewards.unit_inr <= 0) return 0;
  return Math.floor(spendInr / rewards.unit_inr) * rewards.points_per_unit;
}

// ── Offers ───────────────────────────────────────────────────────────────────

/**
 * What the user should SEE, regardless of the stored status:
 * an 'active' offer whose valid_until has passed displays as expired.
 */
export function effectiveOfferStatus(
  offer: Pick<OfferRow, "status" | "valid_until">
): OfferRow["status"] {
  if (offer.status === "active" && offer.valid_until && daysUntil(offer.valid_until) < 0) {
    return "expired";
  }
  return offer.status;
}

/** Active offers first, soonest expiry first; no-expiry offers last among active. */
export function sortOffersForDisplay(offers: OfferRow[]): OfferRow[] {
  const rank: Record<OfferRow["status"], number> = {
    active: 0, used: 1, expired: 2, archived: 3,
  };
  return [...offers].sort((a, b) => {
    const ra = rank[effectiveOfferStatus(a)];
    const rb = rank[effectiveOfferStatus(b)];
    if (ra !== rb) return ra - rb;
    const ea = a.valid_until ?? "9999-12-31";
    const eb = b.valid_until ?? "9999-12-31";
    if (ea !== eb) return ea < eb ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}

// ── Expiry framing (offers + loyalty tiers share this) ──────────────────────

export type ExpiryState =
  | { kind: "none" }                       // no date set
  | { kind: "expired"; days: number }      // days since expiry (positive)
  | { kind: "soon"; days: number }         // expires within the window
  | { kind: "ok"; days: number };

export function expiryState(dateStr: string | null, soonWindowDays = 30): ExpiryState {
  if (!dateStr) return { kind: "none" };
  const d = daysUntil(dateStr);
  if (d < 0) return { kind: "expired", days: -d };
  if (d <= soonWindowDays) return { kind: "soon", days: d };
  return { kind: "ok", days: d };
}
