import type { CardSpec } from "./types";

export const HDFC_INFINIA: CardSpec = {
  product_key: "hdfc_infinia",
  display_name: "HDFC Infinia",
  issuer: "HDFC Bank",
  network: "Visa Infinite",

  // 5 RP per ₹150 base — confirmed 2026-07-08, consistent across sources.
  // SmartBuy gives up to 10X (33 RP per ₹150) on selected categories/merchants.
  rewards: {
    program: "HDFC Reward Points",
    earn_summary: "5 pts / ₹150 (up to 10X via SmartBuy)",
    points_per_unit: 5,
    unit_inr: 150,
  },

  // ⚠ Quarterly bonus milestone UNVERIFIED — intentionally NOT modeled
  // (2026-07-08/10). The Metal edition is widely reported to have SOME
  // quarterly milestone (10,000 bonus points), but public sources actively
  // conflict on the threshold (₹4L vs ₹9L), and HDFC's own card page (via
  // cardinsider.com direct fetch) omits it entirely. The previous ₹8L/₹16L
  // "anniversary" entries were supported by NO source — removed rather than
  // perpetuated. Confirm the real quarterly number from the HDFC app / T&C
  // and add it as its own tier.
  //
  // What IS consistently sourced: renewal fee waived on ₹10L annual spend.
  milestones_monthly: [],
  milestones_anniversary: [
    { spend_inr: 1000000, reward: "Renewal fee (₹12,500 + GST) waived" },
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

  benefits_verified_at: "2026-07-10", // quarterly bonus milestone specifically NOT verified — see comment above

  gmail: {
    // hdfcbank.bank.in is the new (2025+) alerts domain. Old alerts came
    // from hdfcbank.net and hdfcbank.com. We keep all three so historical
    // and current emails both match.
    senders: ["hdfcbank.bank.in", "hdfcbank.net", "hdfcbank.com"],
    subject_hints: ["transaction", "spent", "purchase", "credit card", "payment", "debited"],
  },
};
