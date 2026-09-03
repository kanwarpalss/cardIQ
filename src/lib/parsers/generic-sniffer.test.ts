// Generic sniffer regression tests.
// These ensure the safety-net parser catches transactions even when no
// bank-specific parser matches, while still rejecting marketing emails.

import { describe, it, expect } from "vitest";
import { genericSniff } from "@/lib/parsers/generic-sniffer";

const KNOWN = new Set(["5906", "4455", "9004", "3337", "1234"]);

describe("genericSniff", () => {
  it("catches a hypothetical V4 HDFC format the specific parser misses", () => {
    const out = genericSniff(
      "Card transaction notification",
      "Dear Customer, an amount of Rs 9939.79 was charged to your card ending 5906 at ASSPL. Thank you.",
      "",
      KNOWN
    );
    expect(out).not.toBeNull();
    expect(out?.card_last4).toBe("5906");
    expect(out?.amount_inr).toBe(9939.79);
    expect(out?.txn_type).toBe("debit");
    expect(out?.low_confidence).toBe(true);
  });

  it("catches transactions from a brand-new bank we don't have a parser for", () => {
    const out = genericSniff(
      "Yes Bank Credit Card Alert",
      "INR 250.00 has been debited from your Yes Bank Credit Card no. XX1234 on 09 May 2026 at 14:00. Merchant: SOMECAFE",
      "",
      KNOWN
    );
    expect(out?.card_last4).toBe("1234");
    expect(out?.amount_inr).toBe(250);
    expect(out?.txn_type).toBe("debit");
  });

  it("flags refunds correctly as credit", () => {
    const out = genericSniff(
      "Refund",
      "Rs 500 has been credited to your card XX5906 as refund from Amazon",
      "",
      KNOWN
    );
    expect(out?.txn_type).toBe("credit");
    expect(out?.card_last4).toBe("5906");
  });

  it("captures USD as foreign currency — amount_inr=0 (sentinel)", () => {
    const out = genericSniff(
      "Foreign txn",
      "USD 50.00 charged to card ending 5906 at APPLE.COM",
      "",
      KNOWN
    );
    expect(out?.currency).toBe("USD");
    expect(out?.amount_original).toBe(50);
    // Critical: NOT 50 — dashboard would otherwise sum it as ₹50.
    expect(out?.amount_inr).toBe(0);
  });

  // ── New: foreign currencies that the OLD sniffer missed entirely ──
  it("captures IDR (Indonesian Rupiah) — the SOFITEL bug currency", () => {
    const out = genericSniff(
      "Card alert",
      "IDR 12272062 was debited from your card ending 5906 at SOFITEL BAL",
      "",
      KNOWN
    );
    expect(out?.currency).toBe("IDR");
    expect(out?.amount_original).toBe(12272062);
    expect(out?.amount_inr).toBe(0);
    expect(out?.card_last4).toBe("5906");
  });

  it("captures THB via the ฿ symbol", () => {
    const out = genericSniff(
      "Card alert",
      "฿800 was charged to your card ending 5906 at PHUKET HOTEL",
      "",
      KNOWN
    );
    expect(out?.currency).toBe("THB");
    expect(out?.amount_original).toBe(800);
  });

  it("captures MYR via the RM symbol", () => {
    const out = genericSniff(
      "Card alert",
      "RM 250.00 was debited from your card ending 5906 at KLIA",
      "",
      KNOWN
    );
    expect(out?.currency).toBe("MYR");
    expect(out?.amount_original).toBe(250);
  });

  it("captures HKD", () => {
    const out = genericSniff(
      "Card alert",
      "HKD 1500 was debited from your card ending 5906 at HK DISNEYLAND",
      "",
      KNOWN
    );
    expect(out?.currency).toBe("HKD");
    expect(out?.amount_original).toBe(1500);
  });

  it("captures ₹ symbol as INR", () => {
    const out = genericSniff(
      "Card alert",
      "₹1500 was debited from your card ending 5906 at SWIGGY",
      "",
      KNOWN
    );
    expect(out?.currency).toBeUndefined(); // INR doesn't set the currency field
    expect(out?.amount_inr).toBe(1500);
  });

  it("rejects marketing email despite mentioning amount + card", () => {
    // "Get Rs 500 cashback when you spend Rs 5000 on your card ending 5906"
    // — has amount, has last4, has 'spend' verb. But also has 2 marketing
    // signals (% cashback and offer language) → must be rejected.
    const out = genericSniff(
      "Special Offer for cardholders",
      "Get 50% cashback when you spend on your card ending 5906. Offer expires soon. Click here to redeem.",
      "",
      KNOWN
    );
    expect(out).toBeNull();
  });

  it("rejects email mentioning a last4 that isn't one of the user's cards", () => {
    const out = genericSniff(
      "Statement summary",
      "Rs 1000 was debited from card XX9999 yesterday",  // 9999 not in KNOWN
      "",
      KNOWN
    );
    expect(out).toBeNull();
  });

  it("rejects email with currency + last4 but no transactional verb", () => {
    const out = genericSniff(
      "Statement summary",
      "Your statement balance for card XX5906 is Rs 25000.",
      "",
      KNOWN
    );
    expect(out).toBeNull();
  });

  it("rejects email with verb + last4 but no currency amount", () => {
    const out = genericSniff(
      "Card alert",
      "Your card XX5906 has been used somewhere mysterious.",
      "",
      KNOWN
    );
    expect(out).toBeNull();
  });

  // ── Non-transaction notifications (2026-09 EPM fix) ──────────────────────
  // These mention money + a verb + a real last4, so the checks above would
  // otherwise accept them — but none is a purchase or refund on the card.

  it("rejects an ICICI 'payment received' bill-payment confirmation", () => {
    const out = genericSniff(
      "Payment received on your ICICI Bank Credit Card.",
      "Dear Customer, Greetings from ICICI Bank! We have received payment of INR 23,017.00 on your ICICI Bank Credit Card account 5524 XXXX XXXX 9004 on 05-Apr-2026.",
      "",
      KNOWN
    );
    expect(out).toBeNull();
  });

  it("rejects an ICICI monthly e-statement summary", () => {
    const out = genericSniff(
      "ICICI Bank Credit Card Statement for the period  March 19 2026 to April 18 2026",
      "Payment due by May 6, 2026 ICICI Bank Credit Card XX9004 Minimum Amount Due: ₹3,000.00 Total Amount Due ₹59,995.60 Pay now via UPI.",
      "",
      KNOWN
    );
    expect(out).toBeNull();
  });

  it("rejects an Axis 'Upcoming AutoPay' reminder (future-tense, not yet charged)", () => {
    const out = genericSniff(
      "Upcoming AutoPay txn. reminder",
      "Here's the summary of your upcoming AutoPay transaction: Transaction Amount: INR 299.00 Merchant Name: Spotify India Pvt Ltd To be debited by: 26-04-2026 Axis Bank Credit card No. XX4455",
      "",
      KNOWN
    );
    expect(out).toBeNull();
  });

  it("rejects an Axis 'Pre-debit notification' (future-tense, not yet charged)", () => {
    const out = genericSniff(
      "Pre-debit notification on Axis Bank Card",
      "We wish to inform you that payment of INR 1493.10 for Amazon Seller Services PL will be auto debited via Axis Bank Card No. XX4455 by 11-08-2025.",
      "",
      KNOWN
    );
    expect(out).toBeNull();
  });

  it("rejects the user's own customer-service reply about a reward-points dispute", () => {
    const out = genericSniff(
      "Re: Your Service Request no. 240906326089 for reward points has been successfully processed",
      "Dear Mr. Sethi, we have initiated a request for manual transfer and 5000 edge points has been transferred as per your request. Please spend Rs 150000 to check eligibility for the next milestone.",
      "",
      KNOWN
    );
    expect(out).toBeNull();
  });

  // ── Reversal-summary merchant extraction (2026-09 EPM fix) ───────────────
  // These ARE real transactions (credits) — the bug was a blank merchant,
  // not a phantom row, so they must still parse, just with merchant filled in.

  it("extracts merchant from an Axis reversal-summary email", () => {
    const out = genericSniff(
      "INR 222.63 txn. reversed at UBER INDIA",
      "Here's the summary of the reversal of your transaction: Transaction Amount: INR 222.63 Merchant Name: UBER INDIA Axis Bank Credit Card No. XX4455 Date & Time: 03-03-26, 22:12:17 IST Transaction Status: REVERSED",
      "",
      KNOWN
    );
    expect(out?.txn_type).toBe("credit");
    expect(out?.merchant_raw).toBe("UBER INDIA");
  });

  it("extracts merchant from an HDFC 'from X to HDFC Bank' reversal email", () => {
    const out = genericSniff(
      "Alert :  Update on your HDFC Bank Credit Card",
      "HDFC BANK --> Dear Card Member, We're pleased to inform you that a transaction reversal has been initiated for Rs 2563.57, from MYNTRA VIA SMARTBUY to HDFC Bank Credit Card ending 5906 on 01-05-2025 19:41:16. Please allow up to 48 hours for the reversed transaction to reflect in your card statement.",
      "",
      KNOWN
    );
    expect(out?.txn_type).toBe("credit");
    expect(out?.merchant_raw).toBe("MYNTRA VIA SMARTBUY");
  });

  it("extracts merchant from an Axis legacy 'at X has been reversed' email", () => {
    const out = genericSniff(
      "Transaction alert on Axis Bank Credit Card no. XX4455",
      "Dear Kanwar Pal Singh Sethi, we wish to inform you that the transaction of INR 1082 on Axis Bank Credit Card no. XX4455 on 31-08-25 00:13:08 IST at EXPLOREX TE has been reversed.",
      "",
      KNOWN
    );
    expect(out?.txn_type).toBe("credit");
    expect(out?.merchant_raw).toBe("EXPLOREX TE");
  });
});
