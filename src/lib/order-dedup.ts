// Order de-duplication (V2 feature C). Pure logic, unit-tested in
// order-dedup.test.ts, called by /api/gmail/orders/sync.
//
// One purchase generates SEVERAL emails — the merchant's own order email, the
// payment gateway's confirmation ("Payment successful for <legal entity>"), and
// sometimes a shipper's note — each parsed as a separate order row. KP's rule:
//
//   Same amount + (essentially) the same timestamp  ⇒  almost certainly the
//   SAME purchase, reported through different entities.
//
// Real example: "Bath and Body Works" (merchant) and "Apparel Group" (the
// registered biller) both ₹4181 at the same minute on 12 Jul — one purchase.
//
// So we cluster orders by exact amount + a TIGHT time window and keep one
// PRIMARY per cluster (the richest — a merchant email with items beats a
// gateway confirmation), flagging the rest as duplicates for review. The window
// is deliberately tight: two DISTINCT purchases of the identical paise amount
// within a few minutes is vanishingly rare, so a tight window almost never
// merges genuinely different orders.

import { orderMatchRank } from "./order-match";
import type { OrderSource } from "./parsers/orders/types";

export type DedupOrder = {
  id: string;
  source: OrderSource;
  itemsCount: number;
  total_amount: number | null;
  order_at: string;
  txn_id: string | null;
};

const AMOUNT_TOLERANCE = 0.75;    // same paise, allowing bank rounding
const DEFAULT_WINDOW_MIN = 5;     // "same time" — tight, to avoid false merges
const MIN_MS = 60_000;

function ms(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * The primary is the richest report of the purchase: prefer one already matched
 * to a card charge, then one with item detail, then a merchant email over a
 * gateway confirmation (orderMatchRank), then a stable id tie-break.
 */
function comparePrimary(a: DedupOrder, b: DedupOrder): number {
  const aTxn = a.txn_id ? 1 : 0, bTxn = b.txn_id ? 1 : 0;
  if (aTxn !== bTxn) return bTxn - aTxn;
  if (a.itemsCount !== b.itemsCount) return b.itemsCount - a.itemsCount;
  const rank = orderMatchRank({ source: b.source, itemsCount: b.itemsCount }) -
               orderMatchRank({ source: a.source, itemsCount: a.itemsCount });
  if (rank !== 0) return rank;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Map every duplicate order id → the id of its cluster's primary. Orders NOT in
 * the map are primaries or unique. Deterministic regardless of input order.
 *
 * @param windowMin how many minutes apart still counts as "the same time".
 */
export function findDuplicateOrders(
  orders: DedupOrder[],
  windowMin = DEFAULT_WINDOW_MIN
): Map<string, string> {
  const windowMs = windowMin * MIN_MS;
  // Amount-bearing orders only; sorted by time so a cluster is a contiguous run.
  const sorted = orders
    .filter((o) => o.total_amount != null)
    .sort((a, b) => ms(a.order_at) - ms(b.order_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const dupOf = new Map<string, string>();
  const claimed = new Set<string>();

  for (let i = 0; i < sorted.length; i++) {
    const anchor = sorted[i];
    if (claimed.has(anchor.id)) continue;
    const cluster = [anchor];
    for (let j = i + 1; j < sorted.length; j++) {
      const other = sorted[j];
      if (ms(other.order_at) - ms(anchor.order_at) > windowMs) break; // sorted → no later one qualifies
      if (claimed.has(other.id)) continue;
      if (Math.abs(other.total_amount! - anchor.total_amount!) <= AMOUNT_TOLERANCE) cluster.push(other);
    }
    if (cluster.length < 2) continue;

    const primary = [...cluster].sort(comparePrimary)[0];
    for (const o of cluster) {
      claimed.add(o.id);
      if (o.id !== primary.id) dupOf.set(o.id, primary.id);
    }
  }
  return dupOf;
}
