// Parser regression tests.
//
// These use REAL email samples (with PII redacted) captured from the user's
// inbox. Every time a parser fails or misclassifies a real email, a test
// case for it goes here so we never regress.
//
// Convention: one describe() per bank, one it() per format variant.

import { describe, it, expect } from "vitest";
import { parseAxisTxn } from "@/lib/parsers/axis";
import { parseHdfcTxn } from "@/lib/parsers/hdfc";
import { parseIciciTxn } from "@/lib/parsers/icici";
import { parseHsbcTxn } from "@/lib/parsers/hsbc";
import { parseTxnEmail } from "@/lib/parsers/registry";

// ─── AXIS ──────────────────────────────────────────────────────────────────
describe("parseAxisTxn", () => {
  it("parses standard INR debit", () => {
    const out = parseAxisTxn(
      "INR 101.85 spent on credit card no. XX4455",
      "Transaction Amount: INR 101.85    Merchant Name: PYU*BREWBAY    Axis Bank Credit Card No. XX4455    Date: 07-05-2026",
      ""
    );
    expect(out).toMatchObject({
      card_last4: "4455",
      amount_inr: 101.85,
      merchant_raw: "PYU*BREWBAY",
      txn_type: "debit",
    });
  });

  it("parses INR refund credit", () => {
    const out = parseAxisTxn(
      "INR 500 refund credited to credit card no. XX4455",
      "Transaction Amount: INR 500    Merchant Name: AMAZON.IN    Date: 02-04-2026",
      ""
    );
    expect(out?.txn_type).toBe("credit");
    expect(out?.amount_inr).toBe(500);
    expect(out?.card_last4).toBe("4455");
  });

  it("parses USD debit and prefers INR equivalent", () => {
    const out = parseAxisTxn(
      "USD 224.28 spent on credit card no. XX4455",
      "Transaction Amount: USD 224.28   Indian Rupee Equivalent: INR 18923.45   Merchant Name: APPLE.COM/BILL   Axis Bank Credit Card No. XX4455",
      ""
    );
    expect(out).toMatchObject({
      card_last4: "4455",
      amount_inr: 18923.45,
      currency: "USD",
      amount_original: 224.28,
      txn_type: "debit",
    });
  });

  it("parses USD without INR equivalent — keeps original amount as fallback", () => {
    const out = parseAxisTxn(
      "USD 50.00 spent on credit card no. XX4455",
      "Transaction Amount: USD 50.00 Merchant Name: SOMECORP",
      ""
    );
    expect(out?.currency).toBe("USD");
    expect(out?.amount_original).toBe(50);
    expect(out?.amount_inr).toBe(50); // graceful degradation — caller can convert
  });

  it("ignores non-transactional Axis emails", () => {
    expect(parseAxisTxn("KYC update required for your account", "Some marketing text", "")).toBeNull();
    expect(parseAxisTxn("Your statement is ready", "View your statement", "")).toBeNull();
  });

  it("does not get confused by INR-amount-shaped strings in marketing", () => {
    // "Get INR 500 cashback" should NOT be parsed as a transaction
    expect(parseAxisTxn("Get INR 500 cashback on your next purchase", "marketing body", "")).toBeNull();
  });
});

// ─── HDFC ──────────────────────────────────────────────────────────────────
describe("parseHdfcTxn", () => {
  it("parses new-format debit (2026+)", () => {
    const out = parseHdfcTxn(
      "Rs.350.00 debited via Credit Card **5906",
      "Rs.350.00 is debited from your HDFC Bank Credit Card ending 5906 towards RAZ*GoRally on 05 Feb, 2026 at 21:37:40.",
      ""
    );
    expect(out).toMatchObject({
      card_last4: "5906",
      amount_inr: 350,
      merchant_raw: "RAZ*GoRally",
      txn_type: "debit",
    });
  });

  it("parses V3 InstaAlerts format (May 2026+, 'has been debited')", () => {
    // Real sample from kanwarpalss@gmail.com
    const out = parseHdfcTxn(
      "A payment was made using your Credit Card",
      "Dear Customer, Greetings from HDFC Bank. We would like to inform you that Rs. 9939.79 has been debited from your HDFC Bank Credit Card ending 5906 towards ASSPL on 08 May, 2026 at 08:27:30.",
      ""
    );
    expect(out).toMatchObject({
      card_last4: "5906",
      amount_inr: 9939.79,
      merchant_raw: "ASSPL",
      txn_type: "debit",
    });
    expect(out?.txn_at.getFullYear()).toBe(2026);
    expect(out?.txn_at.getMonth()).toBe(4); // May
    expect(out?.txn_at.getDate()).toBe(8);
  });

  it("parses V3 even when subject is the cryptic 'A payment was made'", () => {
    // Critical regression: V2 used to gate on subject regex. V3 doesn't match
    // V2 subject regex but body should still parse fine.
    const out = parseHdfcTxn(
      "A payment was made using your Credit Card",
      "Rs. 1234.56 has been debited from your HDFC Bank Credit Card ending 5906 towards SOME*MERCHANT on 8 May 2026 at 09:00:00.",
      ""
    );
    expect(out?.amount_inr).toBe(1234.56);
    expect(out?.merchant_raw).toBe("SOME*MERCHANT");
  });

  it("parses old-format debit (pre-2024)", () => {
    const out = parseHdfcTxn(
      "Alert : Update on your HDFC Bank Credit Card",
      "Thank you for using your HDFC Bank Credit Card ending 5906 for Rs 4022.40 at PAYPAL *STANSTEDEXP on 27-08-2023 17:10:44.",
      ""
    );
    expect(out).toMatchObject({
      card_last4: "5906",
      amount_inr: 4022.40,
      merchant_raw: "PAYPAL *STANSTEDEXP",
      txn_type: "debit",
    });
  });

  it("parses old-format refund credit", () => {
    const out = parseHdfcTxn(
      "Alert : Update on your HDFC Bank Credit Card",
      "a refund for Rs 2115.95, from Bolt is credited to your HDFC Bank Credit Card ending 5906 on 27-08-2023 21:54:29.",
      ""
    );
    expect(out).toMatchObject({
      card_last4: "5906",
      amount_inr: 2115.95,
      merchant_raw: "Bolt",
      txn_type: "credit",
    });
  });

  it("parses new-format reversal", () => {
    const out = parseHdfcTxn(
      "Transaction reversal initiated",
      "Transaction reversal of Rs.70.89 has been initiated to your HDFC Bank Credit Card ending 5906. From Merchant:A Grab Booking",
      ""
    );
    expect(out).toMatchObject({
      card_last4: "5906",
      amount_inr: 70.89,
      txn_type: "credit",
    });
  });

  it("ignores HDFC marketing/promo emails", () => {
    expect(parseHdfcTxn("🛍️ Amazon Sale + HDFC Bank Offer", "Shop now and save big", "")).toBeNull();
    expect(parseHdfcTxn("Your monthly e-statement is ready", "Click to view", "")).toBeNull();
  });

  it("parses amount with comma thousands separator", () => {
    const out = parseHdfcTxn(
      "Rs.1,25,000.00 debited via Credit Card **5906",
      "Rs.1,25,000.00 is debited from your HDFC Bank Credit Card ending 5906 towards SOMETHING on 01 Jan, 2026 at 12:00:00.",
      ""
    );
    expect(out?.amount_inr).toBe(125000);
  });
});

// ─── ICICI ─────────────────────────────────────────────────────────────────
describe("parseIciciTxn", () => {
  it("parses standard debit with merchant", () => {
    const out = parseIciciTxn(
      "Transaction alert for your ICICI Bank Credit Card",
      "Your ICICI Bank Credit Card XX9004 has been used for a transaction of INR 6000.00 on Apr 06, 2026 at 10:35:11. Info: REWARD 360 GLOBAL SERV.",
      ""
    );
    expect(out).toMatchObject({
      card_last4: "9004",
      amount_inr: 6000,
      merchant_raw: "REWARD 360 GLOBAL SERV",
      txn_type: "debit",
    });
    expect(out?.txn_at.getFullYear()).toBe(2026);
    expect(out?.txn_at.getMonth()).toBe(3); // April = month index 3
  });

  it("parses credit/reversal", () => {
    const out = parseIciciTxn(
      "Transaction alert",
      "INR 500.00 has been reversed to your ICICI Bank Credit Card XX9004",
      ""
    );
    expect(out).toMatchObject({
      card_last4: "9004",
      amount_inr: 500,
      txn_type: "credit",
    });
  });
});

// ─── HSBC ──────────────────────────────────────────────────────────────────
describe("parseHsbcTxn", () => {
  it("parses standard debit", () => {
    const out = parseHsbcTxn(
      "You have used your HSBC Credit Card",
      "your Credit card no ending with 3337,has been used for INR 1029.60 for payment to ETERNAL LIMITED on 01 May 2026 at 21:22.",
      ""
    );
    expect(out).toMatchObject({
      card_last4: "3337",
      amount_inr: 1029.60,
      merchant_raw: "ETERNAL LIMITED",
      txn_type: "debit",
    });
    expect(out?.txn_at.getFullYear()).toBe(2026);
    expect(out?.txn_at.getMonth()).toBe(4); // May
  });

  it("ignores HSBC marketing emails", () => {
    expect(parseHsbcTxn(
      "Enjoy zero processing fees on EMI bookings",
      "marketing body",
      ""
    )).toBeNull();
  });
});

// ─── REGISTRY (sender → parser routing) ────────────────────────────────────
describe("parseTxnEmail", () => {
  it("routes axis.bank.in to Axis parser", () => {
    const out = parseTxnEmail(
      "Axis Bank Alerts <alerts@axis.bank.in>",
      "INR 100 spent on credit card no. XX4455",
      "Transaction Amount: INR 100 Merchant Name: TEST",
      ""
    );
    expect(out?.card_last4).toBe("4455");
  });

  it("routes hdfcbank.bank.in (V3 InstaAlerts) to HDFC parser", () => {
    const out = parseTxnEmail(
      "HDFC Bank InstaAlerts <alerts@hdfcbank.bank.in>",
      "A payment was made using your Credit Card",
      "Rs. 9939.79 has been debited from your HDFC Bank Credit Card ending 5906 towards ASSPL on 08 May, 2026 at 08:27:30.",
      ""
    );
    expect(out?.card_last4).toBe("5906");
    expect(out?.amount_inr).toBe(9939.79);
  });

  it("routes custcomm.hsbc.co.in to HSBC parser", () => {
    const out = parseTxnEmail(
      "HSBC Credit Cards <noreply@custcomm.hsbc.co.in>",
      "Subject",
      "your Credit card no ending with 3337,has been used for INR 100 for payment to TEST on 01 Jan 2026 at 12:00.",
      ""
    );
    expect(out?.card_last4).toBe("3337");
  });

  it("returns null for unknown sender", () => {
    const out = parseTxnEmail("noreply@randombank.com", "INR 100 spent", "body", "");
    expect(out).toBeNull();
  });
});
