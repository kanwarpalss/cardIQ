import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isMissingTableError, isMissingColumnError } from "@/lib/supabase/errors";

// GET /api/orders — the standalone Orders ledger (V2 feature C).
//
// Returns EVERY parsed order (matched to a card txn or not) — the "what I
// bought" source of truth, decoupled from "what I paid". Voucher-paid orders
// (Amazon via gyftr, etc.) never marry a card charge, so they live here and
// nowhere else. The client filters/searches/paginates from this payload, same
// shape-contract as /api/transactions/all.
//
// For linked orders we attach the paying transaction (card + amount + date) so
// the ledger can show "paid on card ••4321" without a second round-trip.
//
// Migration tolerance: works before 014 (review_status) by degrading — the row
// just comes back without a review state and the client falls back to txn_id
// for the link badge. Missing orders table (011 not run) → clear notice.

const BASE_COLUMNS =
  "id, source, kind, order_ref, merchant_name, total_amount, order_at, items, txn_id, match_confidence, raw_subject, voucher_draws";
const PAGE = 1000;

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const all: Array<Record<string, unknown>> = [];
  let columns = BASE_COLUMNS + ", review_status";

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("orders")
      .select(columns)
      .eq("user_id", user.id)
      .order("order_at", { ascending: false })
      .range(from, from + PAGE - 1);

    if (error) {
      if (isMissingTableError(error)) {
        return NextResponse.json({ error: "missing_orders_table", orders: [] }, { status: 400 });
      }
      // Migration 014 not run yet — retry once without review_status so the
      // ledger still renders (the link badge falls back to txn_id).
      if (isMissingColumnError(error, "review_status") && columns !== BASE_COLUMNS) {
        columns = BASE_COLUMNS;
        from -= PAGE; // redo this page with the narrower column set
        continue;
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data?.length) break;
    all.push(...(data as unknown as Array<Record<string, unknown>>));
    if (data.length < PAGE) break;
  }

  // Attach the paying transaction for linked orders (two-query, not a PostgREST
  // embed — boringly reliable, and matched-order counts are modest). Voucher-
  // funded orders carry no txn_id but their voucher_draws reference the funding
  // GYFTR card charge — resolve those too so the chain can be shown.
  const drawCardTxnId = (o: Record<string, unknown>): string | null => {
    const draws = Array.isArray(o.voucher_draws) ? (o.voucher_draws as Array<{ cardTxnId?: string | null }>) : [];
    return draws.find((d) => d.cardTxnId)?.cardTxnId ?? null;
  };
  const txnIds = [
    ...new Set([
      ...(all.map((o) => o.txn_id).filter(Boolean) as string[]),
      ...(all.map(drawCardTxnId).filter(Boolean) as string[]),
    ]),
  ];
  const txnById = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < txnIds.length; i += PAGE) {
    const slice = txnIds.slice(i, i + PAGE);
    const { data } = await supabase
      .from("transactions")
      .select("id, card_last4, amount_inr, txn_at, merchant")
      .eq("user_id", user.id)
      .in("id", slice);
    for (const t of data ?? []) txnById.set(t.id as string, t);
  }
  for (const o of all) {
    o.txn = o.txn_id ? txnById.get(o.txn_id as string) ?? null : null;
    // For voucher-funded orders, the card that ultimately paid (via the voucher).
    const vctid = drawCardTxnId(o);
    o.voucher_txn = vctid ? txnById.get(vctid) ?? null : null;
    o.voucher_amount = Array.isArray(o.voucher_draws)
      ? (o.voucher_draws as Array<{ amount?: number }>).reduce((s, d) => s + (d.amount ?? 0), 0)
      : 0;
  }

  return NextResponse.json({ orders: all });
}
