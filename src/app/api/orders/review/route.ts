import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isMissingTableError, isMissingColumnError } from "@/lib/supabase/errors";

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
const MIGRATION_014 =
  "Run supabase/migrations/014_order_review_status.sql in the Supabase SQL Editor to enable the review queue.";

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
      .select("id, source, kind, order_ref, merchant_name, total_amount, order_at, items, match_confidence, review_status, txn_id, raw_subject")
      .eq("user_id", user.id)
      .eq("review_status", status)
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

  // Attach the matched transaction to each pending order (two-query).
  const txnIds = [...new Set(orders.map((o) => o.txn_id).filter(Boolean) as string[])];
  const txnById = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < txnIds.length; i += PAGE) {
    const { data } = await supabase
      .from("transactions")
      .select("id, card_last4, amount_inr, txn_at, merchant, category")
      .eq("user_id", user.id)
      .in("id", txnIds.slice(i, i + PAGE));
    for (const t of data ?? []) txnById.set(t.id as string, t);
  }
  for (const o of orders) o.txn = o.txn_id ? txnById.get(o.txn_id as string) ?? null : null;

  return NextResponse.json({ orders });
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

  // Approve keeps the link and blesses it. Reject severs it permanently —
  // clearing txn_id/confidence so the pair never re-proposes and the txn is
  // freed for a different order.
  const updates =
    action === "approve"
      ? { review_status: "confirmed" }
      : { review_status: "rejected", txn_id: null, match_confidence: null, matched_at: null };

  // Approve is only meaningful for a currently-linked order; guard against
  // approving a row whose txn was cleared out from under it.
  const guard = supabase.from("orders").update(updates).eq("id", id).eq("user_id", user.id);
  const { data, error } = await (action === "approve" ? guard.not("txn_id", "is", null) : guard)
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
