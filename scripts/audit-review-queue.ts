/**
 * Read-only audit of the Review queue.
 *
 * Reports rows that cannot be a real order ↔ card-charge pair: they either
 * have no txn_id, point to no transaction, or point to another user's charge.
 *
 * Run: npx tsx scripts/audit-review-queue.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const match = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (match && !process.env[match[1]]) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

import { createClient } from "@supabase/supabase-js";
import { ordersWithValidReviewCharge } from "../src/lib/review-queue";

const PAGE = 1_000;

async function loadAll(table: string, columns: string, query: (q: any) => any) {
  const rows: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query(supabase.from(table).select(columns).range(from, from + PAGE - 1));
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

async function main() {
  const pending = await loadAll(
    "orders",
    "id, user_id, source, kind, merchant_name, total_amount, card_paid_amount, order_at, txn_id, review_status, match_confidence, duplicate_of, order_ref",
    (q) => q.eq("review_status", "pending")
  );
  const linked = await loadAll(
    "orders",
    "id, user_id, kind, total_amount, card_paid_amount, order_at, txn_id",
    (q) => q.not("txn_id", "is", null)
  );
  const txnIds = [...new Set(linked.map((order) => order.txn_id).filter(Boolean))];
  const txns: any[] = [];
  for (let i = 0; i < txnIds.length; i += 100) {
    txns.push(...await loadAll(
      "transactions",
      "id, user_id, amount_inr, txn_at, merchant, txn_type",
      (q) => q.in("id", txnIds.slice(i, i + 100))
    ));
  }
  const txnById = new Map(txns.map((txn) => [txn.id, txn]));

  const noTxnId = pending.filter((order) => !order.txn_id);
  const missingTxn = pending.filter((order) => order.txn_id && !txnById.has(order.txn_id));
  const wrongUserTxn = pending.filter((order) => {
    const txn = txnById.get(order.txn_id);
    return txn && txn.user_id !== order.user_id;
  });
  const validIds = new Set<string>();
  for (const userId of new Set(linked.map((order) => order.user_id as string))) {
    const userOrders = linked
      .filter((order) => order.user_id === userId)
      .map((order) => ({
        ...order,
        total_amount: order.total_amount == null ? null : Number(order.total_amount),
        card_paid_amount: order.card_paid_amount == null ? null : Number(order.card_paid_amount),
      }));
    const userTxns = txns
      .filter((txn) => txn.user_id === userId)
      .map((txn) => ({ ...txn, amount_inr: Number(txn.amount_inr) }));
    for (const order of ordersWithValidReviewCharge(userOrders, userTxns, userId)) {
      validIds.add(order.id);
    }
  }
  const realPairs = pending.filter((order) => validIds.has(order.id));
  const broken = pending.filter((order) => !validIds.has(order.id));
  const structurallyBroken = new Set([...noTxnId, ...missingTxn, ...wrongUserTxn].map((order) => order.id));
  const incompatible = broken.filter((order) => !structurallyBroken.has(order.id));
  const byShape = Object.fromEntries(
    Object.entries(broken.reduce<Record<string, number>>((counts, order) => {
      const key = `${order.source} | ${order.kind} | ${order.duplicate_of ? "duplicate" : "primary"}`;
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {})).sort(([, a], [, b]) => b - a)
  );

  console.log(JSON.stringify({
    pending: pending.length,
    realPairs: realPairs.length,
    noTxnId: noTxnId.length,
    missingTxn: missingTxn.length,
    wrongUserTxn: wrongUserTxn.length,
    incompatibleAmountDateTypeOrDuplicateClaim: incompatible.length,
    brokenBreakdown: byShape,
    broken: broken.map((order) => ({
      id: order.id, source: order.source, kind: order.kind, merchant: order.merchant_name,
      amount: order.total_amount, orderAt: order.order_at, txnId: order.txn_id,
      confidence: order.match_confidence, duplicateOf: order.duplicate_of, ref: order.order_ref,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error("Review queue audit failed:", error.message ?? error);
  process.exit(1);
});
