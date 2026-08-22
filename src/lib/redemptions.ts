// Pure logic for the Redemptions section — the "what do I hold, and when does
// it die" roll-up across three DIFFERENT tables:
//   * loyalty_accounts (migration 009) — airline/hotel miles
//   * reward_balances  (migration 009 + 021) — card-program points
//   * perk_vouchers    (migration 021) — granted certificates/vouchers
//
// Keep UI-free and side-effect-free — everything here is unit-tested in
// redemptions.test.ts. The component renders what these functions return; it
// never re-derives expiry or sorting on its own (ARCH-04).

import { daysUntil } from "./format";
import type { LoyaltyRow, RewardBalanceRow } from "./perks";

// ── Row shape (mirrors migration 021) ───────────────────────────────────────

export type PerkVoucherRow = {
  id: string;
  brand: string;
  title: string | null;
  voucher_type: "hotel_night" | "flight" | "lounge" | "gift_card" | "upgrade" | "other";
  quantity: number;
  value_inr: number | null;
  expires_on: string | null;
  card_id: string | null;
  granted_by: string | null;
  code: string | null;
  status: "unused" | "used" | "expired" | "archived";
  notes: string | null;
  updated_at: string;
};

export const VOUCHER_TYPE_LABELS: Record<PerkVoucherRow["voucher_type"], string> = {
  hotel_night: "Hotel night",
  flight: "Flight",
  lounge: "Lounge",
  gift_card: "Gift card",
  upgrade: "Upgrade",
  other: "Other",
};

// ── Effective status ────────────────────────────────────────────────────────

/**
 * What the user should SEE, regardless of the stored status: an 'unused'
 * voucher whose expires_on has passed displays as expired. Mirrors
 * effectiveOfferStatus() in perks.ts — same rule, same reasoning.
 *
 * Only 'unused' is re-derived. A voucher the user marked 'used' stays used
 * even after its date passes; that's history, not an expiry.
 */
export function effectiveVoucherStatus(
  v: Pick<PerkVoucherRow, "status" | "expires_on">,
  now: Date = new Date()
): PerkVoucherRow["status"] {
  if (v.status === "unused" && v.expires_on && daysUntil(v.expires_on, now) < 0) {
    return "expired";
  }
  return v.status;
}

/** Unused first, then soonest expiry; no-expiry vouchers last within a group. */
export function sortVouchersForDisplay(
  vouchers: PerkVoucherRow[],
  now: Date = new Date()
): PerkVoucherRow[] {
  const rank: Record<PerkVoucherRow["status"], number> = {
    unused: 0, used: 1, expired: 2, archived: 3,
  };
  return [...vouchers].sort((a, b) => {
    const ra = rank[effectiveVoucherStatus(a, now)];
    const rb = rank[effectiveVoucherStatus(b, now)];
    if (ra !== rb) return ra - rb;
    // "9999-12-31" sorts no-expiry rows last WITHOUT treating null as urgent.
    const ea = a.expires_on ?? "9999-12-31";
    const eb = b.expires_on ?? "9999-12-31";
    if (ea !== eb) return ea < eb ? -1 : 1;
    return a.brand.localeCompare(b.brand);
  });
}

// ── Form input parsing ──────────────────────────────────────────────────────
// Lives here, not inline in the component, because these are MONEY and COUNT
// fields — boundary territory that deserves tests rather than an eyeballed
// `isFinite` check in a submit handler.

export type ParsedAmount =
  | { ok: true; value: number | null }   // null = field left blank (optional)
  | { ok: false; error: string };

/** Strips Indian-format separators; blank is a legitimate "not stated". */
const clean = (raw: string) => raw.replace(/[,\s₹]/g, "");

/**
 * A granted voucher's stated cash value. Optional, but when given must be a
 * real non-negative amount — a certificate "worth" −₹500 is meaningless, and
 * unlike a reward-point balance there is no clawback/correction case that
 * would justify a negative.
 */
export function parseVoucherValue(raw: string): ParsedAmount {
  if (!raw.trim()) return { ok: true, value: null };
  const n = Number(clean(raw));
  if (!Number.isFinite(n)) return { ok: false, error: "Value must be a number." };
  if (n < 0) return { ok: false, error: "Value can't be negative." };
  return { ok: true, value: n };
}

/** How many identical certificates are held. Whole number, at least one. */
export function parseVoucherQuantity(raw: string): ParsedAmount {
  const trimmed = clean(raw);
  if (!trimmed) return { ok: true, value: 1 };
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1) {
    return { ok: false, error: "Quantity must be a whole number of 1 or more." };
  }
  return { ok: true, value: n };
}

// ── The unified "expiring soon" roll-up ─────────────────────────────────────

export type RedemptionKind = "miles" | "points" | "voucher";

export type ExpiringItem = {
  id: string;            // unique across kinds — prefixed, see makeId()
  kind: RedemptionKind;
  label: string;         // "Marriott Bonvoy", "Axis Magnus — EDGE Rewards"
  detail: string | null; // "Taj · 1 free night" / "×2"
  expires_on: string;    // YYYY-MM-DD — never null (no-expiry rows are excluded)
  days: number;          // whole days until expiry; negative = already expired
  amount: number | null; // points/miles count, or voucher quantity
  unit: string | null;   // "miles" / "points" / null
};

export type RedemptionSources = {
  loyalty: LoyaltyRow[];
  /** Pass the LATEST snapshot per card only — history rows carry stale expiries. */
  rewards: (RewardBalanceRow & { cardLabel: string })[];
  vouchers: PerkVoucherRow[];
};

const makeId = (kind: RedemptionKind, id: string) => `${kind}:${id}`;

/**
 * Everything expiring within `windowDays`, PLUS anything already expired that
 * still holds a balance the user might not have noticed. Sorted most urgent
 * first (already-expired at the top — those are the ones that actually hurt).
 *
 * Deliberately excluded:
 *   * rows with no expiry date — nothing to warn about
 *   * zero/empty balances — a program with 0 points expiring is not news
 *   * vouchers already marked used or archived
 *   * loyalty TIER expiry — a lapsing tier is a status change, not something
 *     you can redeem. Tiers stay visible in the Miles section but never fire
 *     the "expiring soon" badge, which is reserved for redeemable value.
 */
export function collectExpiring(
  src: RedemptionSources,
  windowDays = 30,
  now: Date = new Date()
): ExpiringItem[] {
  const out: ExpiringItem[] = [];

  const push = (item: ExpiringItem) => {
    if (item.days <= windowDays) out.push(item);
  };

  for (const l of src.loyalty) {
    if (!l.points_expire_on) continue;
    const balance = l.points_balance === null ? null : Number(l.points_balance);
    if (balance !== null && balance <= 0) continue;
    push({
      id: makeId("miles", l.id),
      kind: "miles",
      label: l.program_name,
      detail: l.tier,
      expires_on: l.points_expire_on,
      days: daysUntil(l.points_expire_on, now),
      amount: balance,
      unit: l.program_type === "airline" ? "miles" : "points",
    });
  }

  for (const r of src.rewards) {
    if (!r.points_expire_on) continue;
    const balance = Number(r.balance);
    if (!(balance > 0)) continue;
    push({
      id: makeId("points", r.id),
      kind: "points",
      label: r.cardLabel,
      detail: r.program,
      expires_on: r.points_expire_on,
      days: daysUntil(r.points_expire_on, now),
      amount: balance,
      unit: "points",
    });
  }

  for (const v of src.vouchers) {
    if (!v.expires_on) continue;
    // Re-derive status so an 'unused' row past its date still counts as
    // expired here — but 'used'/'archived' rows are genuinely gone.
    const status = effectiveVoucherStatus(v, now);
    if (status === "used" || status === "archived") continue;
    push({
      id: makeId("voucher", v.id),
      kind: "voucher",
      label: v.brand,
      detail: v.title ?? VOUCHER_TYPE_LABELS[v.voucher_type],
      expires_on: v.expires_on,
      days: daysUntil(v.expires_on, now),
      amount: v.quantity > 1 ? v.quantity : null,
      unit: null,
    });
  }

  return out.sort((a, b) => {
    if (a.days !== b.days) return a.days - b.days; // most urgent (incl. expired) first
    return a.label.localeCompare(b.label);
  });
}

/** Count for the nav badge — expiring soon, but NOT already expired. */
export function countExpiringSoon(items: ExpiringItem[]): number {
  return items.filter((i) => i.days >= 0).length;
}
