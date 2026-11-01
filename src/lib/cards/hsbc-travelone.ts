import type { CardSpec } from "./types";

export const HSBC_TRAVELONE: CardSpec = {
  product_key: "hsbc_travelone",
  display_name: "HSBC TravelOne",
  issuer: "HSBC India",
  // HSBC's page says "Mastercard World Platform benefits" rather than naming the
  // network outright. KP's statements confirm this is the product on card 3337.
  network: "Mastercard World",

  // HSBC TravelOne page and rewards page, read 2026-10-31: 4 points per ₹100 on
  // flights, travel aggregators and foreign currency, 2 per ₹100 on everything
  // else. Footnoted exclusions didn't come through, so none are claimed here.
  rewards: {
    program: "HSBC TravelOne Reward Points",
    earn_summary: "2 pts / ₹100 (4 pts / ₹100 on flights, travel aggregators and foreign currency)",
    points_per_unit: 2,
    unit_inr: 100,
  },

  milestones_monthly: [],
  // HSBC says "a year" without saying which year. With no saved start date these
  // count from the app's default, so set the card's anniversary in Cards.
  milestones_anniversary: [
    { spend_inr: 800000, reward: "₹4,999 annual fee waived" },
    { spend_inr: 1200000, reward: "10,000 bonus reward points" },
  ],

  // Same page: "6 local and 4 international airport lounge visits every year".
  // Provider and guest terms are in a footnote that didn't come through.
  lounge: {
    domestic: { provider: "Not stated on HSBC's page", visits_per_year: 6 },
    international: { provider: "Not stated on HSBC's page", visits_per_year: 4 },
  },

  // Neither TravelOne page mentions bills. Premier's rewards T&C limits these
  // categories, but that isn't confirmed for this card, so it's labelled unknown.
  bill_rules: {
    utilities: {
      earns: "Not stated on HSBC's TravelOne pages; base rate is 2 pts / ₹100",
      limit: "Unconfirmed. HSBC's Premier terms share a ₹1,00,000 monthly limit across bills",
      milestones: "Unconfirmed whether bills count toward the ₹8L and ₹12L thresholds",
    },
    rent: {
      earns: "Not stated on HSBC's TravelOne pages; base rate is 2 pts / ₹100",
      limit: "Unconfirmed. HSBC's Premier terms share a ₹1,00,000 monthly limit across bills",
      milestones: "Unconfirmed whether rent counts toward the ₹8L and ₹12L thresholds",
    },
  },

  sources: {
    deals: "https://www.hsbc.bank.in/credit-cards/products/travelone/",
    points: "https://www.hsbc.bank.in/credit-cards/products/travelone/rewards/",
    lounge: "https://www.hsbc.bank.in/credit-cards/products/travelone/",
  },

  benefits_verified_at: "2026-10-31",

  gmail: {
    senders: ["hsbc.co.in", "mail.hsbc.co.in", "hsbc.bank.in"],
    subject_hints: ["transaction", "spent", "purchase", "credit card"],
  },
};
