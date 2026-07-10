import type { CardSpec } from "./types";

export const ICICI_EMERALDE_PRIVATE_METAL: CardSpec = {
  product_key: "icici_emeralde_private_metal",
  display_name: "ICICI Emeralde Private Metal",
  issuer: "ICICI Bank",
  network: "Mastercard World Elite",

  // 6 ICICI Reward Points per ₹200 on retail spends. Unlimited cap.
  // EazyDiner Prime free; Visit BookMyShow / Cleartrip vouchers via milestones.
  rewards: {
    program: "ICICI Reward Points",
    earn_summary: "6 pts / ₹200 (uncapped)",
    points_per_unit: 6,
    unit_inr: 200,
  },

  // Per KP (cardholder, 2026-07-10): EPM has a ₹1.5L MONTHLY spend milestone.
  // Not on ICICI's public rewards-and-milestone-benefits page (fetched
  // 2026-07-10 — it lists only the ₹8L annual vouchers + ₹10L fee waiver),
  // so this is likely a cardholder-targeted benefit visible in iMobile.
  // Reward wording pending KP's confirmation from the app — update the
  // `reward` string below once known.
  milestones_monthly: [
    { spend_inr: 150000, reward: "Monthly milestone benefit (per card T&Cs — exact reward to be confirmed from iMobile)" },
  ],

  // Anniversary milestones verified 2026-07-10 against ICICI's OFFICIAL
  // rewards-and-milestone-benefits page (direct fetch): ₹8L annual spend →
  // 2 EaseMyTrip vouchers (₹3,000 each); ₹10L annual spend → annual fee
  // (₹12,499 + GST) waived. Previous ₹12L figure was unsourced — corrected.
  milestones_anniversary: [
    { spend_inr: 800000, reward: "₹6,000 in EaseMyTrip vouchers (two ₹3,000 vouchers)" },
    { spend_inr: 1000000, reward: "Annual fee (₹12,499 + GST) waived" },
  ],

  lounge: {
    domestic: {
      provider: "DreamFolks",
      visits_per_year: "unlimited",
      guest_policy: "unlimited primary + add-on; complimentary guest visits",
    },
    international: {
      provider: "Priority Pass",
      visits_per_year: "unlimited",
      guest_policy: "unlimited primary; guests at $32 each",
    },
  },

  sources: {
    deals: "https://www.icicibank.com/personal-banking/cards/credit-card/emeralde-private-metal-credit-card",
    points: "https://www.icicibank.com/personal-banking/cards/credit-card/emeralde-private-metal-credit-card",
    vouchers: "https://www.icicibank.com/offers",
    lounge: "https://www.icicibank.com/personal-banking/cards/credit-card/emeralde-private-metal-credit-card",
  },

  benefits_verified_at: "2026-07-10",

  gmail: {
    // icici.bank.in is the new (2025+) RBI-mandated alerts domain; icicibank.com
    // is the legacy one. Keep both so old + new emails are fetched.
    senders: ["icicibank.com", "icici.bank.in"],
    subject_hints: ["transaction", "spent", "purchase", "credit card"],
  },
};
