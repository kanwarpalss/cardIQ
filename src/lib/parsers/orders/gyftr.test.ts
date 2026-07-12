// Tests for the Gyftr voucher parser. Grounded in KP's real 2026-06-22 email;
// the money (face value) + the multi-voucher loop are the footguns, so each has
// a case that would fail a naive single-shot parser.

import { describe, it, expect } from "vitest";
import { parseGyftrVouchers, isGyftrSender } from "./gyftr";

// The real email body as extractBody yields it (HTML → whitespace-collapsed).
const REAL_BODY =
  "Dear Customer, Congratulations! Thank you for buying Gift Voucher from Gyftr " +
  "via HDFC Bank PayZapp Shop e-Vouchers. Please find your instant voucher details. " +
  "Amazon Fresh Amazon Fresh E-Gift Card Code FVM4B44E36338 Value 2000 " +
  "PIN 6014867399473193 Valid Till 21 Jun 2027 , For Important Instructions, " +
  "Redemption steps & T&C Click Here For any help regarding your Instant Voucher " +
  "Click Here or Call: 18001033313 Warm Regards, Team Instant Vouchers";

const REAL_SUBJECT =
  "Confidential - Your Gift Voucher details from GyFTR via HDFC Bank PayZapp Shop e-Vouchers";

describe("isGyftrSender", () => {
  it("matches the real Gyftr sender, domain-anchored", () => {
    expect(isGyftrSender("GyFTR <gifts@gyftr.com>")).toBe(true);
    expect(isGyftrSender("gifts@gyftr.com")).toBe(true);
  });
  it("does not match a look-alike domain", () => {
    expect(isGyftrSender("phish <gifts@gyftr.com.evil.example>")).toBe(false);
    expect(isGyftrSender("Amazon <no-reply@amazon.in>")).toBe(false);
  });
});

describe("parseGyftrVouchers — the real email", () => {
  const vouchers = parseGyftrVouchers(REAL_SUBJECT, REAL_BODY, "");

  it("extracts exactly one voucher", () => {
    expect(vouchers).toHaveLength(1);
  });
  it("reads the brand, de-doubling Gyftr's repeated name", () => {
    expect(vouchers[0].brand).toBe("Amazon Fresh");
  });
  it("reads the FACE value (spendable balance), not a discounted price", () => {
    expect(vouchers[0].faceValue).toBe(2000);
  });
  it("captures the gift-card code as the voucher id", () => {
    expect(vouchers[0].code).toBe("FVM4B44E36338");
  });
  it("parses Valid Till to an ISO date", () => {
    expect(vouchers[0].validTill).toBe("2027-06-21");
  });
  it("never captures the PIN (a live secret with no analytical value)", () => {
    expect(JSON.stringify(vouchers[0])).not.toContain("6014867399473193");
  });
});

describe("parseGyftrVouchers — edge cases", () => {
  it("returns [] for a non-voucher Gyftr email (expiry reminder / marketing)", () => {
    expect(parseGyftrVouchers("Your voucher expires soon", "Dear Customer, your voucher is expiring. Redeem now.", "")).toEqual([]);
  });

  it("handles multiple vouchers in one email (bulk buy), each with its own brand + value", () => {
    const body =
      "Please find your instant voucher details. " +
      "Amazon Fresh Amazon Fresh E-Gift Card Code AAA111BBB222 Value 2000 PIN 111 Valid Till 21 Jun 2027 " +
      "Swiggy Swiggy E-Gift Card Code CCC333DDD444 Value 500 PIN 222 Valid Till 30 Dec 2026";
    const vouchers = parseGyftrVouchers("", body, "");
    expect(vouchers).toHaveLength(2);
    expect(vouchers[0]).toMatchObject({ brand: "Amazon Fresh", faceValue: 2000, code: "AAA111BBB222" });
    expect(vouchers[1]).toMatchObject({ brand: "Swiggy", faceValue: 500, code: "CCC333DDD444" });
    // The second voucher's PIN must not bleed into the first voucher's fields.
    expect(vouchers[0].faceValue).not.toBe(500);
  });

  it("falls back to the HTML part when the plain text has no voucher block", () => {
    const html =
      "<div>Flipkart Flipkart</div><span>E-Gift Card Code ZZZ999YYY888</span><b>Value 1500</b>";
    const vouchers = parseGyftrVouchers("", "unrelated plain text", html);
    expect(vouchers).toEqual([{ brand: "Flipkart", faceValue: 1500, code: "ZZZ999YYY888" }]);
  });

  it("skips a voucher block with no parseable face value rather than storing junk", () => {
    const body = "Nykaa Nykaa E-Gift Card Code NYK123456789 Valid Till 01 Jan 2028";
    expect(parseGyftrVouchers("", body, "")).toEqual([]);
  });
});
