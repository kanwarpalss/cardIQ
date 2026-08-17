import { describe, it, expect } from "vitest";
import {
  effectiveVoucherStatus,
  sortVouchersForDisplay,
  collectExpiring,
  countExpiringSoon,
  type PerkVoucherRow,
} from "./redemptions";
import type { LoyaltyRow, RewardBalanceRow } from "./perks";

// Fixed "today" so every expiry assertion is deterministic — these tests must
// not change meaning when the wall clock does.
const TODAY = new Date(2026, 7, 14); // 2026-08-14, local midnight

/** Local (not UTC) YYYY-MM-DD offset n days from TODAY. Expiry logic is
 *  local-midnight based, so tests must generate dates the same way. */
function day(offset: number): string {
  const d = new Date(TODAY);
  d.setDate(d.getDate() + offset);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const voucher = (over: Partial<PerkVoucherRow>): PerkVoucherRow => ({
  id: "v1", brand: "Taj", title: null, voucher_type: "hotel_night", quantity: 1,
  value_inr: null, expires_on: null, card_id: null, granted_by: null, code: null,
  status: "unused", notes: null, updated_at: "2026-01-01T00:00:00Z", ...over,
});

const loyalty = (over: Partial<LoyaltyRow>): LoyaltyRow => ({
  id: "l1", program_name: "Marriott Bonvoy", program_type: "hotel", member_id: null,
  tier: null, tier_expires_on: null, points_balance: 1000, points_expire_on: null,
  linked_card: null, notes: null, updated_at: "2026-01-01T00:00:00Z", ...over,
});

const reward = (
  over: Partial<RewardBalanceRow & { cardLabel: string }>
): RewardBalanceRow & { cardLabel: string } => ({
  id: "r1", card_id: "c1", program: "EDGE Rewards", balance: 5000,
  as_of: "2026-08-01", points_expire_on: null, notes: null,
  created_at: "2026-08-01T00:00:00Z", cardLabel: "Axis Magnus", ...over,
});

const empty = { loyalty: [], rewards: [], vouchers: [] };

// ── effectiveVoucherStatus ──────────────────────────────────────────────────

describe("effectiveVoucherStatus", () => {
  it("shows an unused voucher past its date as expired", () => {
    expect(effectiveVoucherStatus({ status: "unused", expires_on: day(-1) }, TODAY))
      .toBe("expired");
  });

  it("does NOT expire a voucher on its expiry date — it is still usable today", () => {
    expect(effectiveVoucherStatus({ status: "unused", expires_on: day(0) }, TODAY))
      .toBe("unused");
  });

  it("leaves a used voucher as used even after the date passes", () => {
    // History, not an expiry — flipping this to 'expired' would misreport
    // something the user actually redeemed.
    expect(effectiveVoucherStatus({ status: "used", expires_on: day(-100) }, TODAY))
      .toBe("used");
  });

  it("treats a null expiry as never expiring", () => {
    expect(effectiveVoucherStatus({ status: "unused", expires_on: null }, TODAY))
      .toBe("unused");
  });
});

// ── sortVouchersForDisplay ──────────────────────────────────────────────────

describe("sortVouchersForDisplay", () => {
  it("puts unused before used/expired/archived", () => {
    const rows = [
      voucher({ id: "archived", status: "archived" }),
      voucher({ id: "used", status: "used" }),
      voucher({ id: "unused", status: "unused" }),
    ];
    expect(sortVouchersForDisplay(rows, TODAY).map((v) => v.id))
      .toEqual(["unused", "used", "archived"]);
  });

  it("sorts soonest expiry first and pushes no-expiry rows last", () => {
    const rows = [
      voucher({ id: "none", expires_on: null }),
      voucher({ id: "far", expires_on: day(200) }),
      voucher({ id: "soon", expires_on: day(3) }),
    ];
    expect(sortVouchersForDisplay(rows, TODAY).map((v) => v.id))
      .toEqual(["soon", "far", "none"]);
  });

  it("does not mutate the input array", () => {
    const rows = [voucher({ id: "b", brand: "B" }), voucher({ id: "a", brand: "A" })];
    sortVouchersForDisplay(rows, TODAY);
    expect(rows.map((v) => v.id)).toEqual(["b", "a"]);
  });
});

// ── collectExpiring: the window boundary ────────────────────────────────────

describe("collectExpiring — window boundaries", () => {
  it("includes something expiring exactly today", () => {
    const items = collectExpiring(
      { ...empty, vouchers: [voucher({ expires_on: day(0) })] }, 30, TODAY
    );
    expect(items).toHaveLength(1);
    expect(items[0].days).toBe(0);
  });

  it("includes the last day of the window (day 30) but excludes day 31", () => {
    const inWindow = collectExpiring(
      { ...empty, vouchers: [voucher({ expires_on: day(30) })] }, 30, TODAY
    );
    const outside = collectExpiring(
      { ...empty, vouchers: [voucher({ expires_on: day(31) })] }, 30, TODAY
    );
    expect(inWindow).toHaveLength(1);
    expect(outside).toHaveLength(0);
  });

  it("still surfaces already-expired holdings, and ranks them most urgent", () => {
    const items = collectExpiring({
      ...empty,
      vouchers: [
        voucher({ id: "soon", expires_on: day(5) }),
        voucher({ id: "gone", expires_on: day(-10) }),
      ],
    }, 30, TODAY);
    expect(items.map((i) => i.id)).toEqual(["voucher:gone", "voucher:soon"]);
    expect(items[0].days).toBe(-10);
  });

  it("excludes rows with no expiry date entirely", () => {
    const items = collectExpiring({
      loyalty: [loyalty({ points_expire_on: null })],
      rewards: [reward({ points_expire_on: null })],
      vouchers: [voucher({ expires_on: null })],
    }, 30, TODAY);
    expect(items).toEqual([]);
  });
});

// ── collectExpiring: what should NOT warn ───────────────────────────────────

describe("collectExpiring — exclusions", () => {
  it("ignores a zero balance — 0 points expiring is not news", () => {
    const items = collectExpiring({
      loyalty: [loyalty({ points_balance: 0, points_expire_on: day(5) })],
      rewards: [reward({ balance: 0, points_expire_on: day(5) })],
      vouchers: [],
    }, 30, TODAY);
    expect(items).toEqual([]);
  });

  it("ignores a negative balance (a corrected/clawed-back snapshot)", () => {
    const items = collectExpiring(
      { ...empty, rewards: [reward({ balance: -500, points_expire_on: day(5) })] },
      30, TODAY
    );
    expect(items).toEqual([]);
  });

  it("still warns when a loyalty balance is unknown (null), since value may exist", () => {
    const items = collectExpiring(
      { ...empty, loyalty: [loyalty({ points_balance: null, points_expire_on: day(5) })] },
      30, TODAY
    );
    expect(items).toHaveLength(1);
    expect(items[0].amount).toBeNull();
  });

  it("ignores vouchers already used or archived", () => {
    const items = collectExpiring({
      ...empty,
      vouchers: [
        voucher({ id: "u", status: "used", expires_on: day(5) }),
        voucher({ id: "a", status: "archived", expires_on: day(5) }),
      ],
    }, 30, TODAY);
    expect(items).toEqual([]);
  });

  it("never fires on loyalty TIER expiry — a lapsing tier is not redeemable value", () => {
    const items = collectExpiring(
      { ...empty, loyalty: [loyalty({ tier: "Gold", tier_expires_on: day(2), points_expire_on: null })] },
      30, TODAY
    );
    expect(items).toEqual([]);
  });

  it("handles Postgres numerics arriving as strings", () => {
    // supabase-js returns numeric columns as strings in some configurations;
    // a string "0" must still count as an empty balance, not a truthy value.
    const items = collectExpiring({
      ...empty,
      rewards: [reward({ balance: "0" as unknown as number, points_expire_on: day(5) })],
    }, 30, TODAY);
    expect(items).toEqual([]);
  });

  it("reads a string balance as a real number when non-zero", () => {
    const items = collectExpiring({
      ...empty,
      rewards: [reward({ balance: "12500" as unknown as number, points_expire_on: day(5) })],
    }, 30, TODAY);
    expect(items[0].amount).toBe(12500);
  });
});

// ── collectExpiring: shape and identity ─────────────────────────────────────

describe("collectExpiring — item shape", () => {
  it("keeps ids unique across kinds that share an underlying row id", () => {
    const items = collectExpiring({
      loyalty: [loyalty({ id: "same", points_expire_on: day(1) })],
      rewards: [reward({ id: "same", points_expire_on: day(2) })],
      vouchers: [voucher({ id: "same", expires_on: day(3) })],
    }, 30, TODAY);
    expect(new Set(items.map((i) => i.id)).size).toBe(3);
    expect(items.map((i) => i.kind)).toEqual(["miles", "points", "voucher"]);
  });

  it("labels airline balances as miles and hotel balances as points", () => {
    const items = collectExpiring({
      ...empty,
      loyalty: [
        loyalty({ id: "air", program_type: "airline", points_expire_on: day(1) }),
        loyalty({ id: "hot", program_type: "hotel", points_expire_on: day(2) }),
      ],
    }, 30, TODAY);
    expect(items.map((i) => i.unit)).toEqual(["miles", "points"]);
  });

  it("shows voucher quantity only when holding more than one", () => {
    const items = collectExpiring({
      ...empty,
      vouchers: [
        voucher({ id: "one", quantity: 1, expires_on: day(1) }),
        voucher({ id: "two", quantity: 2, expires_on: day(2) }),
      ],
    }, 30, TODAY);
    expect(items[0].amount).toBeNull();
    expect(items[1].amount).toBe(2);
  });

  it("falls back to the type label when a voucher has no title", () => {
    const items = collectExpiring(
      { ...empty, vouchers: [voucher({ title: null, voucher_type: "flight", expires_on: day(1) })] },
      30, TODAY
    );
    expect(items[0].detail).toBe("Flight");
  });

  it("breaks day ties alphabetically so ordering is stable", () => {
    const items = collectExpiring({
      ...empty,
      vouchers: [
        voucher({ id: "z", brand: "Zzz", expires_on: day(5) }),
        voucher({ id: "a", brand: "Aaa", expires_on: day(5) }),
      ],
    }, 30, TODAY);
    expect(items.map((i) => i.label)).toEqual(["Aaa", "Zzz"]);
  });
});

// ── countExpiringSoon ───────────────────────────────────────────────────────

describe("countExpiringSoon", () => {
  it("counts upcoming expiries but not ones already gone", () => {
    const items = collectExpiring({
      ...empty,
      vouchers: [
        voucher({ id: "gone", expires_on: day(-1) }),
        voucher({ id: "today", expires_on: day(0) }),
        voucher({ id: "soon", expires_on: day(10) }),
      ],
    }, 30, TODAY);
    expect(items).toHaveLength(3);
    expect(countExpiringSoon(items)).toBe(2);
  });

  it("is zero for an empty ledger", () => {
    expect(countExpiringSoon(collectExpiring(empty, 30, TODAY))).toBe(0);
  });
});
