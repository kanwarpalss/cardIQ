import type { CardSpec } from "./types";

export const AXIS_MAGNUS_BURGUNDY: CardSpec = {
  product_key: "axis_magnus_burgundy",
  display_name: "Axis Magnus Burgundy",
  issuer: "Axis Bank",
  network: "Visa Infinite",

  // Earn rate verified 2026-07-08 (paisabazaar/creditkeeda/cardmaven, consistent):
  // 12 EDGE pts per ₹200 up to ₹1.5L/month, then 35 pts per ₹200 beyond, same
  // calendar month. IMPORTANT (per KP, cardholder, 2026-07-10): this ₹1.5L
  // threshold is an EARN-RATE kink, NOT a milestone reward — nothing is
  // granted AT ₹1.5L, so it must NOT render as a milestone progress bar.
  // It lives here in earn_summary text only. (KP: "the 1.5L milestone is
  // monthly just for EPM — show it honestly even for M4B.")
  rewards: {
    program: "EDGE Rewards",
    earn_summary: "12 pts / ₹200 (35 beyond ₹1.5L monthly)",
    points_per_unit: 12,
    unit_inr: 200,
  },

  milestones_monthly: [],

  // The card's real spend milestone (paisabazaar, 2026-07-08): annual fee of
  // ₹30,000 + GST is waived on ₹30L+ spend in the preceding anniversary year.
  milestones_anniversary: [
    { spend_inr: 3000000, reward: "Annual fee (₹30,000 + GST) waived" },
  ],

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

  benefits_verified_at: "2026-07-10",

  gmail: {
    // Domain-level match: Gmail's `from:axisbank.com` catches every sender at that domain
    // (alerts@, cc.alerts@, creditcards@, noreply@, plus any historical formats).
    senders: ["axisbank.com", "axis.bank.in"],
    subject_hints: ["transaction", "spent", "purchase", "Card ending"],
  },
};
