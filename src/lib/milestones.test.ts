import { describe, expect, it } from "vitest";
import {
  CALENDAR_YEAR_START,
  currentCalendarMonth,
  currentMilestoneYear,
  inclusiveWindowEnd,
  localDateKey,
  spendInWindow,
  type MilestoneTxn,
} from "./milestones";

const txn = (overrides: Partial<MilestoneTxn> = {}): MilestoneTxn => ({
  card_last4: "1234",
  amount_inr: 100,
  original_currency: "INR",
  txn_at: "2026-04-01T00:00:00+05:30",
  txn_type: "debit",
  ...overrides,
});

describe("currentMilestoneYear", () => {
  it("uses HDFC Infinia's 1 Apr product year after the boundary", () => {
    const window = currentMilestoneYear(null, { month: 4, day: 1 }, new Date(2026, 6, 28));
    expect(localDateKey(window.start)).toBe("2026-04-01");
    expect(localDateKey(inclusiveWindowEnd(window))).toBe("2027-03-31");
  });

  it("uses the preceding 1 Apr before the new card year starts", () => {
    const window = currentMilestoneYear(null, { month: 4, day: 1 }, new Date(2026, 2, 31, 23, 59));
    expect(localDateKey(window.start)).toBe("2025-04-01");
    expect(localDateKey(inclusiveWindowEnd(window))).toBe("2026-03-31");
  });

  it("a saved calendar-year override outranks the product default", () => {
    const window = currentMilestoneYear("2024-01-01", { month: 4, day: 1 }, new Date(2026, 6, 28));
    expect(localDateKey(window.start)).toBe("2026-01-01");
    expect(localDateKey(inclusiveWindowEnd(window))).toBe("2026-12-31");
  });

  it("an invalid saved override falls back to the product rule", () => {
    const window = currentMilestoneYear("2026-02-30", { month: 4, day: 1 }, new Date(2026, 6, 28));
    expect(localDateKey(window.start)).toBe("2026-04-01");
  });

  it("clamps a leap-day rule safely in non-leap years", () => {
    const window = currentMilestoneYear("2024-02-29", CALENDAR_YEAR_START, new Date(2027, 6, 1));
    expect(localDateKey(window.start)).toBe("2027-02-28");
  });
});

describe("spendInWindow", () => {
  const window = currentMilestoneYear(null, { month: 4, day: 1 }, new Date(2026, 6, 28));

  it("includes the exact start instant and excludes the next year's boundary", () => {
    expect(spendInWindow([
      txn({ amount_inr: 100, txn_at: "2026-04-01T00:00:00+05:30" }),
      txn({ amount_inr: 200, txn_at: "2027-03-31T23:59:59+05:30" }),
      txn({ amount_inr: 999, txn_at: "2027-04-01T00:00:00+05:30" }),
    ], "1234", window, new Date("2027-03-31T23:59:59.999+05:30"))).toBe(300);
  });

  it("isolates the card and ignores credits, foreign currency, and invalid amounts", () => {
    expect(spendInWindow([
      txn(),
      txn({ card_last4: "9999", amount_inr: 500 }),
      txn({ txn_type: "credit", amount_inr: 300 }),
      txn({ original_currency: "USD", amount_inr: 800 }),
      txn({ amount_inr: null }),
      txn({ amount_inr: -50 }),
    ], "1234", window, new Date("2026-07-28T12:00:00+05:30"))).toBe(100);
  });

  it("treats legacy null currency as INR", () => {
    expect(spendInWindow(
      [
        txn({ original_currency: null, amount_inr: "125.50" }),
        txn({ original_currency: " INR ", amount_inr: 25 }),
      ],
      "1234",
      window,
      new Date("2026-07-28T12:00:00+05:30")
    )).toBe(150.5);
  });

  it("does not count a future-dated debit inside the nominal period", () => {
    expect(spendInWindow([
      txn({ amount_inr: 100, txn_at: "2026-07-01T00:00:00+05:30" }),
      txn({ amount_inr: 900, txn_at: "2026-08-01T00:00:00+05:30" }),
    ], "1234", window, new Date("2026-07-28T12:00:00+05:30"))).toBe(100);
  });

  it("calendar month starts at local midnight and ends exclusively next month", () => {
    const month = currentCalendarMonth(new Date(2026, 6, 28, 12));
    expect(localDateKey(month.start)).toBe("2026-07-01");
    expect(localDateKey(month.endExclusive)).toBe("2026-08-01");
  });
});
