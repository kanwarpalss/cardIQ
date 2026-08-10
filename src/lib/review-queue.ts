import { isOrderTxnPairCompatible } from "./order-match";

/**
 * Review is for a proposed order ↔ card-charge pair, never for an unpaired
 * order. This final guard protects the UI and approval endpoint if historic
 * data is inconsistent.
 */
export type ReviewQueueOrder = {
  id: string;
  txn_id: string | null;
  kind: "order" | "refund";
  total_amount: number | null;
  card_paid_amount?: number | null;
  order_at: string;
};

export type ReviewQueueTxn = {
  id: string;
  user_id: string;
  amount_inr: number;
  txn_at: string;
  txn_type: "debit" | "credit";
};

/** Keep only genuine, still-compatible order ↔ transaction pairs. */
export function ordersWithValidReviewCharge<T extends ReviewQueueOrder>(
  orders: T[],
  txns: ReviewQueueTxn[],
  userId: string
): T[] {
  const txnById = new Map(txns.map((txn) => [txn.id, txn]));
  const compatible = orders.filter((order) => {
    if (!order.txn_id) return false;
    const txn = txnById.get(order.txn_id);
    return txn?.user_id === userId && isOrderTxnPairCompatible(order, txn);
  });
  const claims = new Map<string, number>();
  for (const order of compatible) {
    claims.set(order.txn_id!, (claims.get(order.txn_id!) ?? 0) + 1);
  }
  // One charge cannot truthfully fund two ordinary orders. Suppress an
  // ambiguous historic double-claim instead of letting array order pick one.
  return compatible.filter((order) => claims.get(order.txn_id!) === 1);
}
