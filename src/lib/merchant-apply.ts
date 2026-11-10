/**
 * "Categorize the other N from this merchant?" — which transactions the
 * review popup lists, and which start ticked. Pure so the rules are tested.
 */
import type { CategoryPair } from "./category-taxonomy";

export type ApplyTxn = {
  id: string;
  merchant: string | null;
  category: string | null;
  subcategory?: string | null;
  category_manual?: boolean | null;
  txn_at: string;
  amount_inr: number;
  txn_type: "debit" | "credit";
};

export type ApplyCandidates<T extends ApplyTxn> = {
  /** Same merchant, not yet in the chosen category — newest first. */
  candidates: T[];
  /** Same merchant, already exactly in the chosen category (nothing to do). */
  alreadyThere: number;
};

const samePair = (t: ApplyTxn, pair: CategoryPair) =>
  (t.category || "Uncategorized") === pair.category && (t.subcategory ?? null) === (pair.subcategory ?? null);

/**
 * Other transactions from `source`'s merchant, from the WHOLE history (not
 * just the filtered page), excluding `source` itself. Merchant match is exact,
 * like the merchant rule that may be saved — "Amazon" never drags in
 * "Amazon Fresh".
 */
export function applyCandidates<T extends ApplyTxn>(all: readonly T[], source: ApplyTxn, pair: CategoryPair): ApplyCandidates<T> {
  if (!source.merchant) return { candidates: [], alreadyThere: 0 };
  let alreadyThere = 0;
  const candidates: T[] = [];
  for (const t of all) {
    if (t.id === source.id || t.merchant !== source.merchant) continue;
    if (samePair(t, pair)) alreadyThere++;
    else candidates.push(t);
  }
  candidates.sort((a, b) => new Date(b.txn_at).getTime() - new Date(a.txn_at).getTime());
  return { candidates, alreadyThere };
}

/**
 * Start ticked unless the user already chose that row's category by hand —
 * a deliberate earlier choice is never overridden by default.
 */
export function defaultSelection(candidates: readonly ApplyTxn[]): Set<string> {
  return new Set(candidates.filter((t) => t.category_manual !== true).map((t) => t.id));
}

/**
 * Saving a rule for FUTURE transactions is the default only when every
 * listed transaction is being changed — if some are being left out, the
 * merchant clearly isn't "always" this category.
 */
export function defaultRemember(candidates: readonly ApplyTxn[], selected: ReadonlySet<string>): boolean {
  return candidates.every((t) => selected.has(t.id));
}

/** Net ₹ of the ticked rows (debits minus refunds) for the summary line. */
export function selectedTotal(candidates: readonly ApplyTxn[], selected: ReadonlySet<string>): number {
  let total = 0;
  for (const t of candidates) {
    if (!selected.has(t.id)) continue;
    total += t.txn_type === "credit" ? -t.amount_inr : t.amount_inr;
  }
  return total;
}
