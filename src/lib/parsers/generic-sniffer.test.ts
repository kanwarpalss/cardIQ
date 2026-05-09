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

  it("captures USD as foreign currency", () => {
    const out = genericSniff(
      "Foreign txn",
      "USD 50.00 charged to card ending 5906 at APPLE.COM",
      "",
      KNOWN
    );
    expect(out?.currency).toBe("USD");
    expect(out?.amount_original).toBe(50);
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
});
