/**
 * Review is for a proposed order ↔ card-charge pair, never for an unpaired
 * order. This final guard protects the UI if historic data is inconsistent.
 */
export type ReviewQueueOrder = {
  id: string;
  txn_id: string | null;
};

export type ReviewQueueTxn = {
  id: string;
  user_id: string;
};

/** Keep only orders whose referenced transaction exists and belongs to them. */
export function ordersWithValidReviewCharge<T extends ReviewQueueOrder>(
  orders: T[],
  txns: ReviewQueueTxn[],
  userId: string
): T[] {
  const txnById = new Map(txns.map((txn) => [txn.id, txn]));
  return orders.filter((order) => {
    if (!order.txn_id) return false;
    return txnById.get(order.txn_id)?.user_id === userId;
  });
}
