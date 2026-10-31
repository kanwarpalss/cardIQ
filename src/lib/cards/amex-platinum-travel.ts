import type { CardSpec } from "./types";

export const AMEX_PLATINUM_TRAVEL: CardSpec = {
  product_key: "amex_platinum_travel",
  display_name: "Amex Platinum Travel",
  issuer: "American Express",
  network: "Amex",

  // Amex's product page, read 2026-10-31: 1 MR point per ₹50, except fuel,
  // insurance, utilities, cash and EMI conversion. Utilities means household
  // electricity, gas and water, so phone and broadband fall outside it.
  rewards: {
    program: "Membership Rewards",
    earn_summary: "1 pt / ₹50 (no points on fuel, insurance, utilities, cash or EMI)",
    points_per_unit: 1,
    unit_inr: 50,
  },

  milestones_monthly: [],

  // Live From A Lounge and Book1A (10 Aug 2026): the ₹1.9L milestone was removed
  // from 10 Sep 2026 and ₹7L now gives only the Taj gift card. Amex's current
  // page shows this same ₹4L and ₹7L structure. Annual fee is ₹5,000 + taxes
  // with no spend waiver stated.
  milestones_anniversary: [
    { spend_inr: 400000, reward: "10,000 Membership Rewards points" },
    { spend_inr: 700000, reward: "₹20,000 Taj voucher" },
  ],

  lounge: {
    domestic: {
      provider: "Amex",
      visits_per_year: "2 per quarter",
      guest_policy: "needs ₹70,000 spend in the prior quarter for Oct–Dec 2026 visits, then ₹1 lakh a quarter",
    },
    international: {
      provider: "Priority Pass",
      visits_per_year: "pay per visit",
      guest_policy: "membership is free; cardmember and guest pay a usage fee",
    },
  },

  bill_rules: {
    utilities: {
      earns: "No points on electricity, gas and water (Amex terms)",
      milestones: "Probably counts: Amex's milestone exclusions don't list utilities, but older guides disagree, so ask Amex",
    },
    rent: {
      earns: "Not on Amex's no-points list, but Amex doesn't address rent directly",
      milestones: "Not on Amex's milestone exclusions; ask Amex",
    },
  },

  sources: {
    deals: "https://www.americanexpress.com/in/credit-cards/platinum-travel-credit-card/",
    points: "https://www.americanexpress.com/in/credit-cards/platinum-travel-credit-card/",
    lounge: "https://www.americanexpress.com/in/credit-cards/platinum-travel-credit-card/",
  },

  benefits_verified_at: "2026-10-31",

  gmail: {
    // Deliberately empty: there's no Amex parser, so adding senders would make
    // the sync download mail it can't read and log it as seen. Add the senders
    // together with a parser.
    senders: [],
    subject_hints: [],
  },
};
