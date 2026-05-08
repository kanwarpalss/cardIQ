import type { CardSpec } from "./types";

export const AXIS_MAGNUS_BURGUNDY: CardSpec = {
  product_key: "axis_magnus_burgundy",
  display_name: "Axis Magnus Burgundy",
  issuer: "Axis Bank",
  network: "Visa Infinite",

  // Earn rate: 12 EDGE points per ₹200 up to ₹1.5L/month
  // Accelerated: 35 EDGE points per ₹200 on spend BEYOND ₹1.5L/month
  milestones_monthly: [
    {
      spend_inr: 150000,
      reward: "Earn rate jumps to 35 EDGE points per ₹200 on all spend beyond ₹1.5L this month",
    },
  ],

  milestones_anniversary: [],

  lounge: {
    domestic: {
      provider: "DreamFolks",
      visits_per_year: "unlimited (primary cardholder)",
      guest_policy: "guests charged per visit",
    },
    international: {
      provider: "Priority Pass",
      visits_per_year: 8,
      guest_policy: "guest visits count toward the 8 cap",
    },
  },

  sources: {
    deals: "https://www.axisbank.com/retail/cards/credit-card/magnus-credit-card-burgundy",
    points: "https://www.axisbank.com/retail/cards/credit-card/magnus-credit-card-burgundy/rewards",
    vouchers: "https://axisbank.gyftr.com/",
    lounge: "https://www.axisbank.com/retail/cards/credit-card/magnus-credit-card-burgundy/lounge-access",
  },

  gmail: {
    // Domain-level match: Gmail's `from:axisbank.com` catches every sender at that domain
    // (alerts@, cc.alerts@, creditcards@, noreply@, plus any historical formats).
    senders: ["axisbank.com", "axis.bank.in"],
    subject_hints: ["transaction", "spent", "purchase", "Card ending"],
  },
};
