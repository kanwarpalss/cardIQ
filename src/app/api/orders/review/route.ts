import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isMissingTableError, isMissingColumnError } from "@/lib/supabase/errors";
import { ordersWithValidReviewCharge, type ReviewQueueOrder } from "@/lib/review-queue";

// The order-review queue (V2 feature C, migration 014).
//
//   GET  /api/orders/review  → every 'pending' match (medium/low confidence),
//                              each paired with the transaction it matched, so
//                              KP can eyeball order-detail vs. charge and decide.
//   POST /api/orders/review  → { id, action: 'approve' | 'reject' }
//                              approve → 'confirmed' (flows into Spend).
//                              reject  → 'rejected' + txn_id cleared. PERMANENT
//                                        unlink; never re-proposed (SPEC §5).
//
// High-confidence matches are auto-confirmed at sync time and never enter this
// queue — but the tab can still surface them (status filter) so KP can overturn
// a wrong auto-confirm via the same reject path.

const PAGE = 1000;
const ID_BATCH = 100; // Keep PostgREST .in(...) URLs below header-size limits.
const MIGRATION_014 =
  "Run supabase/migrations/014_order_review_status.sql in the Supabase SQL Editor to enable the review queue.";

function dbNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // ?status=pending (default) | confirmed | rejected — lets the tab pull up
  // auto-confirmed matches to overturn, or review its own past rejects.
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? "pending";
  if (!["pending", "confirmed", "rejected"].includes(status)) {
    return NextResponse.json({ error: "invalid status" }, { status: 400 });
  }

  const orders: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("orders")
      .select("id, source, kind, order_ref, merchant_name, total_amount, card_paid_amount, order_at, items, match_confidence, review_status, txn_id, raw_subject")
      .eq("user_id", user.id)
      .eq("review_status", status)
      .not("txn_id", "is", null)
      .order("order_at", { ascending: false })
      .range(from, from + PAGE - 1);

    if (error) {
      if (isMissingTableError(error)) {
        return NextResponse.json({ error: "missing_orders_table", orders: [] }, { status: 400 });
      }
      if (isMissingColumnError(error, "review_status")) {
        return NextResponse.json({ error: "missing_review_status_column", message: MIGRATION_014, orders: [] }, { status: 400 });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data?.length) break;
    orders.push(...data);
    if (data.length < PAGE) break;
  }

  // Attach the matched transaction to each review order.
  const txnIds = [...new Set(orders.map((o) => o.txn_id).filter(Boolean) as string[])];
  const txnById = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < txnIds.length; i += ID_BATCH) {
    const { data, error } = await supabase
      .from("transactions")
      .select("id, user_id, card_last4, amount_inr, txn_at, merchant, category, txn_type")
      .eq("user_id", user.id)
      .in("id", txnIds.slice(i, i + ID_BATCH));
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    for (const t of data ?? []) txnById.set(t.id as string, t);
  }
  // Validate against every order claiming these charges, not just the selected
  // status tab. A pending + confirmed double-claim is still ambiguous.
  const linkedOrders: Array<Record<string, unknown>> = [];
  for (let i = 0; i < txnIds.length; i += ID_BATCH) {
    const { data, error } = await supabase
      .from("orders")
      .select("id, kind, total_amount, card_paid_amount, order_at, txn_id")
      .eq("user_id", user.id)
      .in("txn_id", txnIds.slice(i, i + ID_BATCH));
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    linkedOrders.push(...(data ?? []));
  }
  const normalizedLinkedOrders: ReviewQueueOrder[] = linkedOrders.map((order) => ({
    id: order.id as string,
    txn_id: order.txn_id as string | null,
    kind: order.kind as "order" | "refund",
    total_amount: dbNumber(order.total_amount),
    card_paid_amount: dbNumber(order.card_paid_amount),
    order_at: order.order_at as string,
  }));
  const normalizedTxns = [...txnById.values()].map((txn) => ({
    ...txn,
    id: txn.id as string,
    user_id: txn.user_id as string,
    amount_inr: dbNumber(txn.amount_inr) ?? Number.NaN,
    txn_at: txn.txn_at as string,
    txn_type: txn.txn_type as "debit" | "credit",
  }));
  const validOrderIds = new Set(
    ordersWithValidReviewCharge(normalizedLinkedOrders, normalizedTxns, user.id)
      .map((order) => order.id)
  );
  const normalizedOrders: Array<Record<string, unknown> & ReviewQueueOrder> = orders.map((order) => ({
    ...order,
    id: order.id as string,
    txn_id: order.txn_id as string | null,
    kind: order.kind as "order" | "refund",
    total_amount: dbNumber(order.total_amount),
    card_paid_amount: dbNumber(order.card_paid_amount),
    order_at: order.order_at as string,
  }));
  const realPairs = normalizedOrders.filter((order) => validOrderIds.has(order.id));
  for (const o of realPairs) {
    const { user_id: _userId, ...txn } = txnById.get(o.txn_id!)!;
    o.txn = txn;
  }

  return NextResponse.json({ orders: realPairs });
}

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const id = body?.id;
  const action = body?.action;
  if (typeof id !== "string" || !id) return NextResponse.json({ error: "id required" }, { status: 400 });
  if (action !== "approve" && action !== "reject") {
    return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400 });
  }

  let approvedTxnId: string | null = null;
  if (action === "approve") {
    // Never bless a stale link merely because it still carries a txn_id. Re-run
    // the same amount/date/type/ownership guard used by GET and Spend.
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select("id, user_id, kind, total_amount, card_paid_amount, order_at, txn_id")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (orderError) return NextResponse.json({ error: orderError.message }, { status: 500 });
    if (!order?.txn_id) {
      return NextResponse.json({ error: "order not found or no longer linked to a transaction" }, { status: 404 });
    }

    const { data: txn, error: txnError } = await supabase
      .from("transactions")
      .select("id, user_id, amount_inr, txn_at, txn_type")
      .eq("id", order.txn_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (txnError) return NextResponse.json({ error: txnError.message }, { status: 500 });

    const { data: claimingOrders, error: claimsError } = await supabase
      .from("orders")
      .select("id, txn_id, kind, total_amount, card_paid_amount, order_at")
      .eq("user_id", user.id)
      .eq("txn_id", order.txn_id);
    if (claimsError) return NextResponse.json({ error: claimsError.message }, { status: 500 });

    const valid = txn && ordersWithValidReviewCharge(
      (claimingOrders ?? []).map((claim) => ({
        id: claim.id,
        txn_id: claim.txn_id,
        kind: claim.kind as "order" | "refund",
        total_amount: dbNumber(claim.total_amount),
        card_paid_amount: dbNumber(claim.card_paid_amount),
        order_at: claim.order_at,
      })),
      [{
        id: txn.id,
        user_id: txn.user_id,
        amount_inr: dbNumber(txn.amount_inr) ?? Number.NaN,
        txn_at: txn.txn_at,
        txn_type: txn.txn_type as "debit" | "credit",
      }],
      user.id
    ).some((claim) => claim.id === order.id);
    if (!valid) {
      return NextResponse.json(
        { error: "This proposed match is no longer a valid order-to-charge pair." },
        { status: 409 }
      );
    }
    approvedTxnId = order.txn_id;
  }

  // Approve keeps the link and blesses it. Reject severs it permanently —
  // clearing txn_id/confidence so the pair never re-proposes and the txn is
  // freed for a different order.
  const updates =
    action === "approve"
      ? { review_status: "confirmed" }
      : { review_status: "rejected", txn_id: null, match_confidence: null, matched_at: null };

  // Approve is only meaningful for a currently-linked order; guard against
  // approving a row whose txn was cleared out from under it.
  let guard = supabase.from("orders").update(updates).eq("id", id).eq("user_id", user.id);
  if (action === "approve") guard = guard.eq("txn_id", approvedTxnId!);
  const { data, error } = await guard
    .select("id, review_status")
    .maybeSingle();

  if (error) {
    if (isMissingColumnError(error, "review_status")) {
      return NextResponse.json({ error: "missing_review_status_column", message: MIGRATION_014 }, { status: 400 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json(
      { error: action === "approve" ? "order not found or no longer linked to a transaction" : "order not found" },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true, id: data.id, review_status: data.review_status });
}
