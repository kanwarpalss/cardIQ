// One loader for the Redemptions section, shared by BOTH the Redemptions tab
// and the sidebar's "expiring soon" badge in page.tsx.
//
// Why shared: the badge exists so KP sees an expiry warning WITHOUT opening the
// tab. If page.tsx computed its own count, the badge and the page could disagree
// (ARCH-04). One loader, one definition of "expiring".

import { createClient } from "./supabase/client";
import { isMissingTableError, isMissingColumnError } from "./supabase/errors";
import { CARD_REGISTRY } from "./cards/registry";
import { latestBalanceByCard, type LoyaltyRow, type RewardBalanceRow } from "./perks";
import { collectExpiring, type ExpiringItem, type PerkVoucherRow } from "./redemptions";

export const EXPIRY_WINDOW_DAYS = 30;

export type RedemptionCard = {
  id: string;
  last4: string;
  nickname: string | null;
  product_key: string;
};

export const cardLabel = (c: RedemptionCard) =>
  c.nickname || CARD_REGISTRY[c.product_key]?.display_name || c.product_key;

export type RedemptionsData = {
  cards: RedemptionCard[];
  loyalty: LoyaltyRow[];
  rewards: RewardBalanceRow[];
  vouchers: PerkVoucherRow[];
  /** Everything expiring within the window, plus already-expired holdings. */
  expiring: ExpiringItem[];
  /** migration 009 hasn't been run — miles + card points unavailable. */
  perksTableMissing: boolean;
  /** migration 021's perk_vouchers table hasn't been run. */
  vouchersTableMissing: boolean;
  /** migration 021's reward_balances.points_expire_on column hasn't been run. */
  expiryColumnMissing: boolean;
  error: string | null;
};

export async function loadRedemptions(now: Date = new Date()): Promise<RedemptionsData> {
  const supabase = createClient();

  const [cardsRes, loyaltyRes, rewardsRes, vouchersRes] = await Promise.all([
    supabase.from("cards").select("id,last4,nickname,product_key").order("created_at"),
    supabase.from("loyalty_accounts").select("*").order("program_name"),
    supabase
      .from("reward_balances")
      .select("*")
      .order("as_of", { ascending: false })
      .order("created_at", { ascending: false }),
    supabase.from("perk_vouchers").select("*").order("brand"),
  ]);

  let error: string | null = null;
  const note = (e: { message?: string } | null) => {
    if (e?.message && !error) error = e.message;
  };

  const perksTableMissing =
    isMissingTableError(loyaltyRes.error) || isMissingTableError(rewardsRes.error);
  const vouchersTableMissing = isMissingTableError(vouchersRes.error);

  // A pre-021 database has the table but not the column. Selecting "*" still
  // succeeds — the column is simply absent from every row — so detect it by
  // shape, not by error, and degrade to "no expiry tracked yet" rather than
  // silently showing every balance as never-expiring with no explanation.
  const rewards = (rewardsRes.data as RewardBalanceRow[]) ?? [];
  const expiryColumnMissing =
    rewards.length > 0 && !rewards.some((r) => "points_expire_on" in r);

  if (!perksTableMissing) {
    note(loyaltyRes.error);
    note(rewardsRes.error);
  }
  if (!vouchersTableMissing) note(vouchersRes.error);
  note(cardsRes.error);

  const cards = (cardsRes.data as RedemptionCard[]) ?? [];
  const loyalty = (loyaltyRes.data as LoyaltyRow[]) ?? [];
  const vouchers = (vouchersRes.data as PerkVoucherRow[]) ?? [];

  // Only the LATEST snapshot per card can warn — older snapshots carry expiry
  // dates the user has since superseded.
  const byId = new Map(cards.map((c) => [c.id, c]));
  const latest = [...latestBalanceByCard(rewards).values()].map((r) => {
    const card = byId.get(r.card_id);
    return { ...r, cardLabel: card ? cardLabel(card) : "Unknown card" };
  });

  const expiring = collectExpiring(
    { loyalty, rewards: latest, vouchers },
    EXPIRY_WINDOW_DAYS,
    now
  );

  return {
    cards, loyalty, rewards, vouchers, expiring,
    perksTableMissing, vouchersTableMissing, expiryColumnMissing, error,
  };
}

/** Re-exported so callers don't need a second import just for the column check. */
export { isMissingColumnError };
