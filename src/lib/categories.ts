/**
 * Canonical list of spend categories.
 * Used by: categorize.ts (rule engine), API routes, and the UI dropdown.
 * To add a new system category, add it here — it appears everywhere automatically.
 */

export const CATEGORIES = [
  "Dining",
  "Groceries",
  "Shopping",
  "Transport",
  "Travel",
  "Entertainment",
  "Utilities",
  "Healthcare",
  "Education",
  "Financial",
  "Fuel",
  "Rent",
  "Vouchers",
  "Pets",
  "Sports & Recreation",
  "CRED Payments",
  "Rewards",
  "Uncategorized",
] as const satisfies readonly string[];

export type KnownCategory = (typeof CATEGORIES)[number];
