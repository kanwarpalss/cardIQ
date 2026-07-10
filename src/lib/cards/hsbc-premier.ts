import type { CardSpec } from "./types";

export const HSBC_PREMIER: CardSpec = {
  product_key: "hsbc_premier",
  display_name: "HSBC Premier",
  issuer: "HSBC India",
  network: "Mastercard World Elite",

  // 3 reward points per ₹100 on all categories (no cap).
  // 5x reward points on overseas spends.
  rewards: {
    program: "HSBC Reward Points",
    earn_summary: "3 pts / ₹100 (5x overseas)",
    points_per_unit: 3,
    unit_inr: 100,
  },

  milestones_monthly: [],
  milestones_anniversary: [],

  // CORRECTED 2026-07-08 via hsbc.co.in official site (direct fetch — highest
  // confidence source used in this pass): lounge access is UNLIMITED for the
  // primary cardholder at both domestic and international airports (1,400+
  // via LoungeKey) — the previous 4/year domestic + 6/year international caps
  // were not supported by any source and have been removed. The "8" figure is
  // a GUEST allowance (international only), not a primary-cardholder cap.
  lounge: {
    domestic: {
      provider: "LoungeKey",
      visits_per_year: "unlimited",
      guest_policy: "primary cardholder only — no cap; guest visits not covered domestically",
    },
    international: {
      provider: "LoungeKey",
      visits_per_year: "unlimited",
      guest_policy: "unlimited for primary; 8 complimentary international guest visits/year",
    },
  },

  sources: {
    deals: "https://www.hsbc.co.in/credit-cards/products/premier/",
    points: "https://www.hsbc.co.in/credit-cards/products/premier/rewards/",
    vouchers: "https://www.hsbc.co.in/credit-cards/offers/",
    lounge: "https://www.hsbc.co.in/credit-cards/products/premier/",
  },

  benefits_verified_at: "2026-07-08",

  gmail: {
    senders: ["hsbc.co.in", "mail.hsbc.co.in"],
    subject_hints: ["transaction", "spent", "purchase", "credit card"],
  },
};
