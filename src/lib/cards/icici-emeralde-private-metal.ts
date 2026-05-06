import type { CardSpec } from "./types";

export const ICICI_EMERALDE_PRIVATE_METAL: CardSpec = {
  product_key: "icici_emeralde_private_metal",
  display_name: "ICICI Emeralde Private Metal",
  issuer: "ICICI Bank",
  network: "Mastercard World Elite",

  // 6 ICICI Reward Points per ₹200 on retail spends. Unlimited cap.
  // EazyDiner Prime free; Visit BookMyShow / Cleartrip vouchers via milestones.
  milestones_monthly: [],
  milestones_anniversary: [
    { spend_inr: 1200000, reward: "EaseMyTrip voucher worth ₹6,000" },
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

  gmail: {
    senders: ["credit_cards@icicibank.com", "alerts@icicibank.com", "transactions@icicibank.com"],
    subject_hints: ["transaction", "spent", "purchase", "credit card"],
  },
};
