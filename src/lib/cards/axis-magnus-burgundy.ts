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
  // The 35-point rate stops at credit limit + ₹1.5L a month, then falls back to
  // 12 (Live From A Lounge, May 2025; CardMaven, Oct 2026). Tolls earn nothing
  // from 28 Aug 2026 (Axis revision notice).
  rewards: {
    program: "EDGE Rewards",
    earn_summary: "12 pts / ₹200 (35 beyond ₹1.5L monthly, up to credit limit + ₹1.5L)",
    points_per_unit: 12,
    unit_inr: 200,
  },

  milestones_monthly: [],

  // The card's real spend milestone (paisabazaar, 2026-07-08): annual fee of
  // ₹30,000 + GST is waived on ₹30L+ spend in the preceding anniversary year.
  milestones_anniversary: [
    { spend_inr: 3000000, reward: "Annual fee (₹30,000 + GST) waived" },
  ],

  // Axis revision notice: from 28 Aug 2026 domestic lounges take the card itself,
  // not Priority Pass. CardMaven (Oct 2026) adds a ₹50,000 spend condition that
  // Axis's readable text doesn't state. International is unlimited for the
  // primary with 4 guest visits (CardMaven and Axis's page; CardMaven's pros
  // list says 8, which contradicts its own detail).
  lounge: {
    domestic: {
      provider: "Card swipe",
      visits_per_year: "unlimited",
      guest_policy: "CardMaven: needs ₹50,000 spend in the previous 3 months; ask Axis",
    },
    international: {
      provider: "Priority Pass",
      visits_per_year: "unlimited",
      guest_policy: "primary only; 4 complimentary guest visits a year",
    },
  },

  // Axis Key Fact Sheet, 8 Oct 2026: the utility fee, the rent fee, and both
  // bill types excluded from the fee waiver. "No points" and the ₹1.5L threshold
  // rest on Live From A Lounge (2023) and CardMaven (Oct 2026). The utility codes
  // reported there include phone and cable.
  bill_rules: {
    utilities: {
      earns: "No points, phone and cable included (CardMaven, Live From A Lounge)",
      fee: "1% once utilities reach ₹25,000 in a statement cycle (Axis fee sheet)",
      milestones: "Doesn't count toward the ₹30L waiver (Axis) or the ₹1.5L monthly threshold",
    },
    rent: {
      earns: "Not stated by Axis in what's readable; user reports say NoBroker earned none",
      fee: "1% of each rent payment (Axis fee sheet)",
      milestones: "Doesn't count toward the ₹30L waiver (Axis)",
    },
  },

  sources: {
    deals: "https://www.axisbank.com/retail/cards/credit-card/magnus-credit-card-burgundy",
    points: "https://www.axisbank.com/retail/cards/credit-card/magnus-credit-card-burgundy/rewards",
    vouchers: "https://axisbank.gyftr.com/",
    lounge: "https://www.axisbank.com/retail/cards/credit-card/magnus-credit-card-burgundy/lounge-access",
  },

  benefits_verified_at: "2026-10-31",

  gmail: {
    // Domain-level match: Gmail's `from:axisbank.com` catches every sender at that domain
    // (alerts@, cc.alerts@, creditcards@, noreply@, plus any historical formats).
    senders: ["axisbank.com", "axis.bank.in"],
    subject_hints: ["transaction", "spent", "purchase", "Card ending"],
  },
};
