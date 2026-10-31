import type { CardSpec } from "./types";

export const ICICI_EMERALDE_PRIVATE_METAL: CardSpec = {
  product_key: "icici_emeralde_private_metal",
  display_name: "ICICI Emeralde Private Metal",
  issuer: "ICICI Bank",
  network: "Mastercard World Elite",

  // ICICI T&C last updated 21 May 2026: 6 points per ₹200, no points on rent,
  // government, tax, property management, wallet load or fuel. Per statement
  // cycle: utilities, groceries and education cap at 1,000 points each,
  // insurance at 5,000.
  rewards: {
    program: "ICICI Reward Points",
    earn_summary: "6 pts / ₹200 (per cycle: utilities, groceries, education 1,000 pts each; insurance 5,000)",
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

  // ICICI T&C of 21 May 2026 splits the EaseMyTrip vouchers: the 1st ₹3,000 at
  // ₹4L and the 2nd at ₹8L in an anniversary year. ICICI's product page, read
  // 2026-10-31: ₹10L spend waives the ₹12,499 + GST annual fee.
  milestones_anniversary: [
    { spend_inr: 400000, reward: "₹3,000 EaseMyTrip voucher (1st of 2)" },
    { spend_inr: 800000, reward: "₹3,000 EaseMyTrip voucher (2nd of 2)" },
    { spend_inr: 1000000, reward: "Annual fee (₹12,499 + GST) waived" },
  ],

  // ICICI's product page, read 2026-10-31. It states no guest allowance and no
  // guest charge, so the earlier "complimentary guests" and "$32" claims went.
  lounge: {
    domestic: {
      provider: "Card swipe",
      visits_per_year: "unlimited",
      guest_policy: "primary + add-on; no guest terms published",
    },
    international: {
      provider: "Priority Pass",
      visits_per_year: "unlimited",
      guest_policy: "primary + add-on; no guest terms published",
    },
  },

  // Fee and milestone lines come from ICICI's Nov 2024 notice. Its milestone
  // exclusions name rent, government and education but not utilities.
  bill_rules: {
    utilities: {
      earns: "6 pts / ₹200 (ICICI terms); phone and broadband codes are included",
      limit: "1,000 points per statement cycle, about ₹33,300 of spend",
      fee: "1% on a utility payment over ₹50,000 (ICICI notice, Nov 2024)",
      milestones: "Probably counts: the Nov 2024 exclusions don't list utilities",
    },
    rent: {
      earns: "No points (ICICI terms); property management codes also earn none",
      milestones: "Doesn't count (ICICI notice, Nov 2024)",
    },
  },

  sources: {
    deals: "https://www.icicibank.com/personal-banking/cards/credit-card/emeralde-private-metal-credit-card",
    points: "https://www.icicibank.com/personal-banking/cards/credit-card/emeralde-private-metal-credit-card",
    vouchers: "https://www.icicibank.com/offers",
    lounge: "https://www.icicibank.com/personal-banking/cards/credit-card/emeralde-private-metal-credit-card",
  },

  benefits_verified_at: "2026-10-31", // ₹1.5L monthly milestone is cardholder-attested only — see comment above

  gmail: {
    // icici.bank.in is the new (2025+) RBI-mandated alerts domain; icicibank.com
    // is the legacy one. Keep both so old + new emails are fetched.
    senders: ["icicibank.com", "icici.bank.in"],
    subject_hints: ["transaction", "spent", "purchase", "credit card"],
  },
};
