import type { CardSpec } from "./types";

export const HDFC_SWIGGY: CardSpec = {
  product_key: "hdfc_swiggy",
  display_name: "Swiggy HDFC",
  issuer: "HDFC Bank",
  network: "Mastercard",

  // 10% cashback on Swiggy (Food, Instamart, Dineout, Genie) — capped ₹1,500/month
  // 5% cashback on online MCCs — capped ₹1,500/month
  // 1% on other spends
  milestones_monthly: [],
  milestones_anniversary: [],

  lounge: {
    domestic: {
      provider: "DreamFolks",
      visits_per_year: 4,
      guest_policy: "primary only",
    },
  },

  sources: {
    deals: "https://www.hdfcbank.com/personal/pay/cards/credit-cards/swiggy-hdfc-bank-credit-card",
    points: "https://www.swiggy.com/",
    vouchers: "https://offers.smartbuy.hdfcbank.com/",
  },

  gmail: {
    senders: ["hdfcbank.net", "hdfcbank.com"],
    subject_hints: ["transaction", "spent", "purchase", "Swiggy"],
  },
};
