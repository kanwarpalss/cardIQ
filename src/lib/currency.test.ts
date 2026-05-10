// Tests for centralized currency detection.
//
// These cover the rules from lib/currency.ts:
//   1. Explicit ISO code near a number wins
//   2. Unambiguous symbol (₹, €, £, Rp, RM, ฿, ₩, ₫) maps to its code
//   3. "Rs."/"Rs " near a digit → INR
//   4. Ambiguous $ / ¥ → USD/JPY only as fallback
//   5. Default → INR

import { describe, it, expect } from "vitest";
import { detectCurrency, isInr, extractAmountAndCurrency } from "./currency";

describe("detectCurrency", () => {
  // ── Rule 1: ISO codes ─────────────────────────────────────────────────
  it("detects INR from explicit code", () => {
    expect(detectCurrency("Transaction Amount: INR 1234.56")).toBe("INR");
  });
  it("detects USD", () => {
    expect(detectCurrency("USD 50.00 spent on credit card")).toBe("USD");
  });
  it("detects IDR (the SOFITEL bug currency)", () => {
    expect(detectCurrency("Transaction Amount: IDR 12272062")).toBe("IDR");
  });
  it("detects THB", () => {
    expect(detectCurrency("THB 800 charged at PHUKET HOTEL")).toBe("THB");
  });
  it("detects MYR", () => {
    expect(detectCurrency("MYR 250.00 at KLIA Duty Free")).toBe("MYR");
  });
  it("detects HKD", () => {
    expect(detectCurrency("HKD 1500 spent at HK Disneyland")).toBe("HKD");
  });
  it("detects AED", () => {
    expect(detectCurrency("AED 200 at DUBAI MALL")).toBe("AED");
  });

  // ── Rule 2: symbols ──────────────────────────────────────────────────
  it("detects ₹ symbol → INR", () => {
    expect(detectCurrency("Spent ₹500 today")).toBe("INR");
  });
  it("detects € symbol → EUR", () => {
    expect(detectCurrency("Charged €50.00 at Paris")).toBe("EUR");
  });
  it("detects £ symbol → GBP", () => {
    expect(detectCurrency("Paid £100 at Tesco")).toBe("GBP");
  });
  it("detects Rp symbol → IDR", () => {
    expect(detectCurrency("Total: Rp 50000")).toBe("IDR");
  });
  it("detects ฿ symbol → THB", () => {
    expect(detectCurrency("Paid ฿800 at 7-Eleven")).toBe("THB");
  });

  // ── Rule 3: Rs./Rs ──────────────────────────────────────────────────
  it("detects 'Rs.' → INR", () => {
    expect(detectCurrency("Rs. 9939.79 has been debited")).toBe("INR");
  });
  it("detects 'Rs ' → INR", () => {
    expect(detectCurrency("for Rs 4022.40 at PAYPAL")).toBe("INR");
  });
  it("does not mis-detect 'Rsync' as INR", () => {
    // No digit nearby + word continues → fail to match the Rs. rule.
    // Falls through to default, which is INR anyway, so this is more
    // of a sanity check that we don't crash.
    expect(detectCurrency("Rsync completed successfully")).toBe("INR");
  });

  // ── Rule 4: ambiguous $ / ¥ ─────────────────────────────────────────
  it("treats '$' as USD when no other signal", () => {
    expect(detectCurrency("Charged $50.00")).toBe("USD");
  });
  it("treats '¥' as JPY when no other signal", () => {
    expect(detectCurrency("Paid ¥1000")).toBe("JPY");
  });
  it("prefers explicit SGD code over '$' symbol", () => {
    // Real-world Axis email pattern: "SGD 50.00 (S$50.00)"
    expect(detectCurrency("Transaction Amount: SGD 50.00 (S$50.00)")).toBe("SGD");
  });

  // ── Rule 5: default → INR ───────────────────────────────────────────
  it("defaults to INR when no currency cue is present", () => {
    expect(detectCurrency("Spent 500 today")).toBe("INR");
  });
  it("defaults to INR for empty input", () => {
    expect(detectCurrency("")).toBe("INR");
  });

  // ── Anti-false-positives ────────────────────────────────────────────
  it("does NOT detect 3-letter words like 'THE' or 'AND' as currency", () => {
    // "THE 500" → "THE" is not a known ISO code, falls through to default INR
    expect(detectCurrency("THE bill was 500")).toBe("INR");
    expect(detectCurrency("AND 1000 more rupees")).toBe("INR");
  });
  it("ignores ISO code that is far from any number", () => {
    // The "USD" appears in a footer disclosure, but there's a clear
    // INR amount earlier — pick INR.
    expect(detectCurrency("Rs. 500 was debited. Note: USD rates apply for foreign txns.")).toBe("INR");
  });

  // ── The actual SOFITEL bug reproducer ───────────────────────────────
  it("real SOFITEL email body returns IDR (not INR despite the limit lines)", () => {
    const body =
      "Transaction Amount: IDR 12272062 Merchant Name: SOFITEL BAL " +
      "Available Limit*: INR 112060.04 Total Credit Limit*: INR 1217000";
    expect(detectCurrency(body)).toBe("IDR");
  });
});

describe("isInr", () => {
  it("treats null as INR (legacy rows)", () => {
    expect(isInr(null)).toBe(true);
  });
  it("treats undefined as INR", () => {
    expect(isInr(undefined)).toBe(true);
  });
  it("treats empty string as INR", () => {
    expect(isInr("")).toBe(true);
  });
  it("treats 'INR' as INR (uppercase)", () => {
    expect(isInr("INR")).toBe(true);
  });
  it("treats 'inr' as INR (lowercase)", () => {
    expect(isInr("inr")).toBe(true);
  });
  it("treats 'USD' as not INR", () => {
    expect(isInr("USD")).toBe(false);
  });
  it("treats 'IDR' as not INR", () => {
    expect(isInr("IDR")).toBe(false);
  });
});

describe("extractAmountAndCurrency", () => {
  it("pulls amount + IDR from a SOFITEL-style fragment", () => {
    const out = extractAmountAndCurrency("IDR 12272062 at SOFITEL");
    expect(out).toEqual({ currency: "IDR", amount: 12272062 });
  });
  it("pulls amount + INR from a Rs. fragment", () => {
    const out = extractAmountAndCurrency("Rs. 9939.79 debited");
    expect(out).toEqual({ currency: "INR", amount: 9939.79 });
  });
  it("returns null if there's no number at all", () => {
    expect(extractAmountAndCurrency("no amount here")).toBeNull();
  });
});
