import type { CardSpec } from "./types";

export const HSBC_PREMIER: CardSpec = {
  product_key: "hsbc_premier",
  display_name: "HSBC Premier",
  issuer: "HSBC India",
  network: "Mastercard World Elite",

  // HSBC Reward Points T&C and rewards page, read 2026-10-31: 3 points per ₹100.
  // Fuel earns none. A group of categories (utilities, rent, insurance, tax and
  // others) earns only up to a shared ₹1,00,000 a month. The T&C file is undated.
  // The earlier "5x overseas" isn't on either page, so it went.
  rewards: {
    program: "HSBC Reward Points",
    earn_summary: "3 pts / ₹100 (no points on fuel; utilities, rent, insurance, tax and others share a ₹1L monthly limit)",
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

  // No spend milestones. The ₹20,000 renewal fee is waived by holding a Premier
  // banking relationship, not by spending. Only MCC 4900 is named as utilities,
  // so phone and broadband should earn normally. That's an inference.
  bill_rules: {
    utilities: {
      earns: "3 pts / ₹100 (HSBC terms)",
      limit: "First ₹1,00,000 a month, shared with rent, insurance, tax and others",
      milestones: "Card has no spend milestones",
    },
    rent: {
      earns: "3 pts / ₹100 (HSBC terms)",
      limit: "Same shared ₹1,00,000 a month",
      milestones: "Card has no spend milestones",
    },
  },

  sources: {
    deals: "https://www.hsbc.bank.in/credit-cards/products/premier/",
    points: "https://www.hsbc.bank.in/credit-cards/products/premier/rewards/",
    vouchers: "https://www.hsbc.co.in/credit-cards/offers/",
    lounge: "https://www.hsbc.bank.in/credit-cards/products/premier/",
  },

  benefits_verified_at: "2026-10-31",

  gmail: {
    senders: ["hsbc.co.in", "mail.hsbc.co.in"],
    subject_hints: ["transaction", "spent", "purchase", "credit card"],
  },
};
