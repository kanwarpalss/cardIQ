/**
 * DEFAULT spend categories — what a user starts with. Since 2026-11-10 the
 * user can add / rename / merge / delete their own (see
 * category-taxonomy.ts + migration 025); this list only seeds that tree and
 * names what the keyword rules in categorize.ts emit.
 *
 * 2026-11-10 regroup (KP): 18 → 14 groups. Fuel + FASTag moved under
 * Transport, Rent + Utilities became Home & Bills, CRED Payments sits under
 * Financial, Jewellery under Shopping, Vouchers + Rewards merged, and
 * Sports & Recreation became Sports & Fitness. REGROUP_MOVES below maps every
 * old name to its new home; scripts/category-regroup.ts applies it to
 * existing data (dry run by default).
 */

export const CATEGORIES = [
  "Dining",
  "Groceries",
  "Shopping",
  "Transport",
  "Travel",
  "Home & Bills",
  "Entertainment",
  "Sports & Fitness",
  "Healthcare",
  "Education",
  "Pets",
  "Financial",
  "Vouchers & Rewards",
  "Uncategorized",
] as const satisfies readonly string[];

export type KnownCategory = (typeof CATEGORIES)[number];

/**
 * Default second tier. Categories with an empty list simply have no
 * suggested subcategories; users can add their own.
 */
export const SUBCATEGORIES: Record<KnownCategory, readonly string[]> = {
  "Dining":             ["Coffee", "Food Delivery", "Restaurants", "Desserts", "Bars & Pubs"],
  "Groceries":          ["Quick Commerce", "Supermarket", "Fruits & Vegetables"],
  "Shopping":           ["Marketplace", "Fashion", "Electronics", "Beauty", "Home", "Jewellery"],
  "Transport":          ["Cabs", "Auto", "Metro & Rail", "Bus", "Fuel", "FASTag"],
  "Travel":             ["Flights", "Hotels", "Packages", "Lounges"],
  "Home & Bills":       ["Rent", "Electricity", "Mobile & Broadband", "DTH"],
  "Entertainment":      ["Streaming", "Movies & Events", "Music"],
  "Sports & Fitness":   ["Pickleball", "Padel", "Gym & Fitness", "Equipment"],
  "Healthcare":         ["Pharmacy", "Diagnostics", "Hospitals & Clinics"],
  "Education":          ["Online Courses"],
  "Pets":               ["Food & Supplies", "Vet & Grooming"],
  "Financial":          ["Insurance", "Investments", "EMI", "CRED Payments"],
  "Vouchers & Rewards": ["Gift Cards", "Reward Credits"],
  "Uncategorized":      [],
};

export type RegroupMove = {
  /** `subcategory` omitted = any; `merchantContains` = case-insensitive merchant match. */
  from: { category: string; subcategory?: string; merchantContains?: string };
  /** `subcategory` omitted = keep the row's own subcategory. */
  to: { category: string; subcategory?: string | null };
};

/**
 * Old default → new default, for data saved before the regroup.
 * ORDER MATTERS — first match wins: specific moves (a subcategory, or a
 * FASTag merchant the old rules filed as plain "Utilities") come before
 * their category-wide move.
 */
export const REGROUP_MOVES: readonly RegroupMove[] = [
  { from: { category: "Fuel" },                               to: { category: "Transport", subcategory: "Fuel" } },
  { from: { category: "Utilities", subcategory: "FASTag" },   to: { category: "Transport", subcategory: "FASTag" } },
  { from: { category: "Utilities", merchantContains: "fastag" }, to: { category: "Transport", subcategory: "FASTag" } },
  { from: { category: "Utilities" },                          to: { category: "Home & Bills" } },
  { from: { category: "Rent" },                               to: { category: "Home & Bills", subcategory: "Rent" } },
  { from: { category: "CRED Payments" },                      to: { category: "Financial", subcategory: "CRED Payments" } },
  { from: { category: "Financial", subcategory: "Jewellery" }, to: { category: "Shopping", subcategory: "Jewellery" } },
  { from: { category: "Vouchers" },                           to: { category: "Vouchers & Rewards" } },
  { from: { category: "Rewards" },                            to: { category: "Vouchers & Rewards", subcategory: "Reward Credits" } },
  { from: { category: "Sports & Recreation" },                to: { category: "Sports & Fitness" } },
];

/** The first regroup move that applies to this row, or null when none does. */
export function regroupMoveFor(
  row: { category: string | null; subcategory?: string | null; merchant?: string | null },
): RegroupMove | null {
  const sub = row.subcategory ?? null;
  const merchant = (row.merchant ?? "").toLowerCase();
  for (const move of REGROUP_MOVES) {
    if (move.from.category !== row.category) continue;
    if (move.from.subcategory !== undefined && move.from.subcategory !== sub) continue;
    if (move.from.merchantContains && !merchant.includes(move.from.merchantContains)) continue;
    return move;
  }
  return null;
}

/** Where a pre-regroup row belongs now (unchanged when no move applies). */
export function regroupPair(
  row: { category: string | null; subcategory?: string | null; merchant?: string | null },
): { category: string | null; subcategory: string | null } {
  const move = regroupMoveFor(row);
  const sub = row.subcategory ?? null;
  if (!move) return { category: row.category, subcategory: sub };
  return { category: move.to.category, subcategory: move.to.subcategory === undefined ? sub : move.to.subcategory };
}

/** "Dining" + "Coffee" → "Dining · Coffee"; no subcategory → just "Dining". */
export function formatCategory(category: string | null, subcategory?: string | null): string {
  const cat = category || "Uncategorized";
  return subcategory ? `${cat} · ${subcategory}` : cat;
}
