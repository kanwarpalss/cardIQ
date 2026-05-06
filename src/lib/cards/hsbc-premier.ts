import type { CardSpec } from "./types";

export const HSBC_PREMIER: CardSpec = {
  product_key: "hsbc_premier",
  display_name: "HSBC Premier",
  issuer: "HSBC India",
  network: "Mastercard World Elite",

  // 3 reward points per ₹100 on all categories (no cap).
  // 5x reward points on overseas spends.
  milestones_monthly: [],
  milestones_anniversary: [],

  lounge: {
    domestic: {
      provider: "Mastercard / DreamFolks",
      visits_per_year: 4,
      guest_policy: "primary only",
    },
    international: {
      provider: "Mastercard Travel Pass / LoungeKey",
      visits_per_year: 6,
      guest_policy: "primary only; guests at access fee",
    },
  },

  sources: {
    deals: "https://www.hsbc.co.in/credit-cards/products/premier-mastercard/",
    points: "https://www.hsbc.co.in/credit-cards/rewards/",
    vouchers: "https://www.hsbc.co.in/credit-cards/offers/",
    lounge: "https://www.hsbc.co.in/credit-cards/products/premier-mastercard/lounge-access/",
  },

  gmail: {
    senders: ["hsbc@mail.hsbc.co.in", "alerts@hsbc.co.in", "noreply@hsbc.co.in", "creditcards@hsbc.co.in"],
    subject_hints: ["transaction", "spent", "purchase", "credit card"],
  },
};
