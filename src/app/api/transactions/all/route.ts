import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isMissingColumnError } from "@/lib/supabase/errors";

// Returns ALL transactions for the user (plus matched orders for the
// expand-row enrichment). Client filters/aggregates from this.
// Pages internally to avoid Supabase's 1000-row default limit.
//
// Migration tolerance: works before 012 (subcategory column) and before 011
// (orders table) by degrading — transactions come back without subcategory,
// orders come back empty. Core spend view must never depend on new migrations.

const TXN_COLUMNS = "id, card_last4, amount_inr, original_currency, original_amount, merchant, category, txn_at, txn_type, card_id, notes";

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const PAGE = 1000;
  const all: Array<Record<string, unknown>> = [];
  let from = 0;
  let columns = TXN_COLUMNS + ", subcategory";

  while (true) {
    const { data, error } = await supabase
      .from("transactions")
      .select(columns)
      .eq("user_id", user.id)
      .order("txn_at", { ascending: false })
      .range(from, from + PAGE - 1);

    if (error) {
      if (isMissingColumnError(error, "subcategory") && columns !== TXN_COLUMNS) {
        columns = TXN_COLUMNS; // migration 012 not run yet — retry without it
        continue;
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data?.length) break;
    // Dynamic column string defeats supabase-js's literal-string type parser.
    all.push(...(data as unknown as Array<Record<string, unknown>>));
    if (data.length < PAGE) break;
    from += PAGE;
  }

  // Matched orders (V2 feature C) — keyed by txn_id on the client. Only
  // CONFIRMED matches surface in Spend (migration 014): high-confidence ones
  // auto-confirm, medium/low wait in the Review tab until KP approves them, so
  // a guessed link never masquerades as truth here.
  //   • Missing orders table (011 not run)  → no enrichment.
  //   • Missing review_status (014 not run) → degrade to "any linked order"
  //     (pre-014 behaviour), so Spend keeps working before the migration.
  const orders: Array<Record<string, unknown>> = [];
  let orderCols = "id, source, kind, order_ref, merchant_name, total_amount, order_at, items, txn_id, match_confidence, review_status";
  let confirmedOnly = true;
  for (let oFrom = 0; ; oFrom += PAGE) {
    let q = supabase
      .from("orders")
      .select(orderCols)
      .eq("user_id", user.id)
      .range(oFrom, oFrom + PAGE - 1);
    q = confirmedOnly ? q.eq("review_status", "confirmed") : q.not("txn_id", "is", null);
    const { data, error } = await q;
    if (error) {
      if (isMissingColumnError(error, "review_status") && confirmedOnly) {
        orderCols = "id, source, kind, order_ref, merchant_name, total_amount, order_at, items, txn_id, match_confidence";
        confirmedOnly = false;
        oFrom -= PAGE; // redo this page with the pre-014 query
        continue;
      }
      break; // missing table (011) or transient — degrade to no enrichment
    }
    if (!data?.length) break;
    orders.push(...(data as unknown as Array<Record<string, unknown>>));
    if (data.length < PAGE) break;
  }

  const [{ data: cards }, { data: settings }] = await Promise.all([
    supabase.from("cards").select("id, last4, nickname, product_key, anniversary_date").eq("user_id", user.id),
    supabase.from("user_settings").select("last_gmail_sync_at").eq("user_id", user.id).single(),
  ]);

  return NextResponse.json({
    transactions: all,
    orders,
    cards: cards || [],
    last_sync: settings?.last_gmail_sync_at ?? null,
  });
}
