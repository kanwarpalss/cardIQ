import type { CardSpec } from "./types";

export const HDFC_SWIGGY: CardSpec = {
  product_key: "hdfc_swiggy",
  display_name: "Swiggy HDFC",
  issuer: "HDFC Bank",
  network: "Mastercard",

  // Confirmed 2026-07-08 via paisabazaar.com/cardinsider.com:
  // 10% cashback on Swiggy (Food, Instamart, Dineout, Genie) — capped ₹1,500/cycle,
  // min txn ₹249 (raised from ₹100, effective 17 Apr 2026)
  // 5% cashback on other online spends — capped ₹1,500/cycle
  // 1% on everything else (incl. offline) — capped ₹500/cycle
  // Cashback card: "points" are ₹ of cashback; base rate = 1% (₹1 per ₹100).
  rewards: {
    program: "Swiggy Cashback (₹)",
    earn_summary: "10% Swiggy · 5% online · 1% other (caps: ₹1,500/₹1,500/₹500 per cycle)",
    points_per_unit: 1,
    unit_inr: 100,
  },

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

  benefits_verified_at: "2026-07-08",

  gmail: {
    senders: ["hdfcbank.bank.in", "hdfcbank.net", "hdfcbank.com"],
    subject_hints: ["transaction", "spent", "purchase", "Swiggy", "debited"],
  },
};
