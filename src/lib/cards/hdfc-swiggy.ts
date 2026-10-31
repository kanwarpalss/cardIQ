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

  // HDFC's terms v4.17 (Oct 2026) list a ₹2L annual spend waiver on the ₹500 fee.
  // HDFC is moving holders of this card to Swiggy Ornge or BLCK in phases.
  milestones_monthly: [],
  milestones_anniversary: [
    { spend_inr: 200000, reward: "Annual fee (₹500) waived" },
  ],

  lounge: {
    domestic: {
      provider: "DreamFolks",
      visits_per_year: 4,
      guest_policy: "primary only",
    },
  },

  // HDFC's page for this original card doesn't mention utility bills in the
  // parts readable on 2026-10-31. The Ornge terms exclude rent but not
  // utilities, which implies 1% there. The utility fee is HDFC's consumer-card rule.
  bill_rules: {
    utilities: {
      earns: "Unclear on this card; Swiggy Ornge terms imply 1% cashback",
      fee: "1% on the whole month's utilities once they exceed ₹50,000 (max ₹4,999 a month)",
      milestones: "HDFC doesn't say whether this counts toward the ₹2L waiver",
    },
    rent: {
      earns: "No cashback on Swiggy Ornge (HDFC terms); this card's terms not readable",
      fee: "1% of each rent payment (max ₹4,999 a payment)",
      milestones: "HDFC doesn't say whether this counts toward the ₹2L waiver",
    },
  },

  sources: {
    deals: "https://www.hdfcbank.com/personal/pay/cards/credit-cards/swiggy-hdfc-bank-credit-card",
    points: "https://www.swiggy.com/",
    vouchers: "https://offers.smartbuy.hdfcbank.com/",
  },

  benefits_verified_at: "2026-10-31",

  gmail: {
    senders: ["hdfcbank.bank.in", "hdfcbank.net", "hdfcbank.com"],
    subject_hints: ["transaction", "spent", "purchase", "Swiggy", "debited"],
  },
};
