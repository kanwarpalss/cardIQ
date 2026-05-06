export type Milestone = {
  spend_inr: number;
  reward: string;
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
};
