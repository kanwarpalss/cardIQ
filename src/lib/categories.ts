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

/**
 * Canonical second tier (V2 feature A). Same contract as CATEGORIES:
 * add a subcategory here and it appears in every dropdown automatically.
 * Categories with an empty list simply have no suggested second tier —
 * users can still type a custom subcategory (persisted as free text,
 * exactly like custom categories).
 */
export const SUBCATEGORIES: Record<KnownCategory, readonly string[]> = {
  "Dining":              ["Coffee", "Food Delivery", "Restaurants", "Desserts", "Bars & Pubs"],
  "Groceries":           ["Quick Commerce", "Supermarket", "Fruits & Vegetables"],
  "Shopping":            ["Marketplace", "Fashion", "Electronics", "Beauty", "Home"],
  "Transport":           ["Cabs", "Auto", "Metro & Rail", "Bus"],
  "Travel":              ["Flights", "Hotels", "Packages", "Lounges"],
  "Entertainment":       ["Streaming", "Movies & Events", "Music"],
  "Utilities":           ["Mobile & Broadband", "Electricity", "DTH", "FASTag"],
  "Healthcare":          ["Pharmacy", "Diagnostics", "Hospitals & Clinics"],
  "Education":           ["Online Courses"],
  "Financial":           ["Insurance", "Investments", "EMI", "Jewellery"],
  "Fuel":                [],
  "Rent":                [],
  "Vouchers":            ["Gift Cards"],
  "Pets":                ["Food & Supplies", "Vet & Grooming"],
  "Sports & Recreation": ["Pickleball", "Padel", "Gym & Fitness", "Equipment"],
  "CRED Payments":       [],
  "Rewards":             [],
  "Uncategorized":       [],
};

/** "Dining" + "Coffee" → "Dining · Coffee"; no subcategory → just "Dining". */
export function formatCategory(category: string | null, subcategory?: string | null): string {
  const cat = category || "Uncategorized";
  return subcategory ? `${cat} · ${subcategory}` : cat;
}
