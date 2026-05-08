import type { CardSpec } from "./types";

export const HDFC_INFINIA: CardSpec = {
  product_key: "hdfc_infinia",
  display_name: "HDFC Infinia",
  issuer: "HDFC Bank",
  network: "Visa Infinite",

  // 5 RP per ₹150 base. SmartBuy gives 10X (33 RP per ₹150) on selected categories.
  // Quarterly milestone is the headline benefit (₹4L → ₹4K voucher options).
  milestones_monthly: [],
  milestones_anniversary: [
    { spend_inr: 800000, reward: "10,000 bonus reward points (Q1)" },
    { spend_inr: 1600000, reward: "10,000 bonus reward points (Q2 cumulative)" },
  ],

  lounge: {
    domestic: {
      provider: "Priority Pass",
      visits_per_year: "unlimited",
      guest_policy: "unlimited primary + add-on; guests at $27 each via PP",
    },
    international: {
      provider: "Priority Pass",
      visits_per_year: "unlimited",
      guest_policy: "unlimited primary + add-on; guests at $27 each via PP",
    },
  },

  sources: {
    deals: "https://www.hdfcbank.com/personal/pay/cards/credit-cards/infinia-metal-credit-card",
    points: "https://offers.smartbuy.hdfcbank.com/",
    vouchers: "https://offers.smartbuy.hdfcbank.com/",
    lounge: "https://www.hdfcbank.com/personal/pay/cards/credit-cards/infinia-metal-credit-card/lounge",
  },

  gmail: {
    senders: ["hdfcbank.net", "hdfcbank.com"],
    subject_hints: ["transaction", "spent", "purchase", "credit card"],
  },
};
