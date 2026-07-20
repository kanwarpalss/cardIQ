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

// Columns present since the orders table existed — always safe to select.
const SAFE_COLUMNS =
  "id, source, kind, order_ref, merchant_name, total_amount, order_at, items, txn_id, match_confidence, raw_subject";
// Added by later migrations (014/015/016). Each is dropped from the query if its
// migration hasn't been run, so the ledger still renders on a partial schema.
const OPTIONAL_COLUMNS = [
  "review_status", "voucher_draws", "duplicate_of",
  "card_paid_amount", "voucher_paid_amount", "voucher_brand_key", "payment_evidence",
];
const PAGE = 1000;

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const all: Array<Record<string, unknown>> = [];
  const optional = [...OPTIONAL_COLUMNS];

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("orders")
      .select([SAFE_COLUMNS, ...optional].join(", "))
      .eq("user_id", user.id)
      .order("order_at", { ascending: false })
      .range(from, from + PAGE - 1);

    if (error) {
      if (isMissingTableError(error)) {
        return NextResponse.json({ error: "missing_orders_table", orders: [] }, { status: 400 });
      }
      // A later migration isn't run — drop that optional column and retry the
      // page so the ledger still renders on a partial schema.
      const missing = optional.find((c) => isMissingColumnError(error, c));
      if (missing) {
        optional.splice(optional.indexOf(missing), 1);
        from -= PAGE;
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
  const drawCardTxnIds = (o: Record<string, unknown>): string[] => {
    const draws = Array.isArray(o.voucher_draws) ? (o.voucher_draws as Array<{ cardTxnId?: string | null }>) : [];
    return [...new Set(draws.map((d) => d.cardTxnId).filter(Boolean) as string[])];
  };
  const txnIds = [
    ...new Set([
      ...(all.map((o) => o.txn_id).filter(Boolean) as string[]),
      ...all.flatMap(drawCardTxnIds),
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
    const voucherTxnIds = drawCardTxnIds(o);
    const vctid = voucherTxnIds[0] ?? null;
    o.voucher_txn = vctid ? txnById.get(vctid) ?? null : null;
    o.voucher_txns = voucherTxnIds.map((id) => txnById.get(id)).filter(Boolean);
    o.voucher_amount = Array.isArray(o.voucher_draws)
      ? (o.voucher_draws as Array<{ amount?: number }>).reduce((s, d) => s + (d.amount ?? 0), 0)
      : 0;
  }

  return NextResponse.json({ orders: all });
}
