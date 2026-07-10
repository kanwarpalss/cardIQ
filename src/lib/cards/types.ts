export type Milestone = {
  spend_inr: number;
  reward: string;
};

export type RewardProgram = {
  program: string;          // e.g. "EDGE Rewards" — used to label balances
  earn_summary: string;     // human-readable base rate, e.g. "12 pts / ₹200"
  points_per_unit: number;  // base earn: points per unit_inr of spend
  unit_inr: number;         // e.g. 200 → 12 points per ₹200
};

export type LoungeEntitlement = {
  provider: string;
  visits_per_year: number | "unlimited" | string;
  guest_policy?: string;
};

export type CardSpec = {
  product_key: string;
  display_name: string;
  issuer: string;
  network: string;
  rewards?: RewardProgram;  // optional: cashback-only cards may omit
  milestones_monthly: Milestone[];
  milestones_anniversary: Milestone[];
  lounge: {
    domestic?: LoungeEntitlement;
    international?: LoungeEntitlement;
  };
  sources: Record<string, string>; // topic -> URL
  gmail: {
    senders: string[];
    subject_hints: string[];
  };
  // Date (YYYY-MM-DD) this card's benefit data was last checked against real
  // sources. Shown in the UI so stale data is visible rather than silently
  // trusted forever — re-verify and bump this when benefits data is refreshed.
  benefits_verified_at?: string;
};
