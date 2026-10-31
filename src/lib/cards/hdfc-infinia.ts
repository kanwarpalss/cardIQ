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
  // HDFC's terms v4.17 (Oct 2026) don't list a quarterly milestone either.
  //
  // What IS consistently sourced: renewal fee waived on ₹10L annual spend.
  // Separately, from 1 Apr 2026 keeping Infinia needs ₹18L card spend in the
  // financial year or a ₹50L relationship value (same terms). That's a
  // condition, not a reward, so it isn't modeled as a milestone.
  milestones_monthly: [],
  milestones_anniversary: [
    { spend_inr: 1000000, reward: "Renewal fee (₹12,500 + GST) waived" },
  ],
  // HDFC tracks Infinia milestone/renewal spend from 1 Apr through 31 Mar.
  milestone_year_start: { month: 4, day: 1 },

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

  // HDFC's terms v4.17 (Oct 2026). They don't say whether either bill type
  // counts toward the ₹10L waiver. Telecom has its own separate 2,000 points.
  bill_rules: {
    utilities: {
      earns: "5 pts / ₹150 (HDFC terms)",
      limit: "2,000 points a calendar month, about ₹60,000 of spend; telecom has its own 2,000",
      fee: "1% on the whole month's utilities once they exceed ₹50,000 (max ₹4,999 a month)",
      milestones: "HDFC doesn't say whether this counts toward the ₹10L waiver",
    },
    rent: {
      earns: "No points (HDFC terms)",
      fee: "1% of each rent payment (max ₹4,999 a payment)",
      milestones: "HDFC doesn't say whether this counts toward the ₹10L waiver",
    },
  },

  sources: {
    deals: "https://www.hdfcbank.com/personal/pay/cards/credit-cards/infinia-metal-credit-card",
    points: "https://offers.smartbuy.hdfcbank.com/",
    vouchers: "https://offers.smartbuy.hdfcbank.com/",
    lounge: "https://www.hdfcbank.com/personal/pay/cards/credit-cards/infinia-metal-credit-card/lounge",
  },

  benefits_verified_at: "2026-10-31", // quarterly bonus milestone specifically NOT verified — see comment above

  gmail: {
    // hdfcbank.bank.in is the new (2025+) alerts domain. Old alerts came
    // from hdfcbank.net and hdfcbank.com. We keep all three so historical
    // and current emails both match.
    senders: ["hdfcbank.bank.in", "hdfcbank.net", "hdfcbank.com"],
    subject_hints: ["transaction", "spent", "purchase", "credit card", "payment", "debited"],
  },
};
