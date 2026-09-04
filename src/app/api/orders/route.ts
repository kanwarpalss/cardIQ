import { NextResponse } from "next/server";
import { isObsoleteAmazonDeliveryOrder } from "@/lib/imports/order-upload";
import { createClient } from "@/lib/supabase/server";
import { isMissingTableError, isMissingColumnError } from "@/lib/supabase/errors";
import { fetchAllPaginated, type PageResult } from "@/lib/paginate";

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
  "id, source, kind, gmail_message_id, order_ref, merchant_name, total_amount, order_at, items, txn_id, match_confidence, raw_subject";
// Added by later migrations (014/015/016). Each is dropped from the query if its
// migration hasn't been run, so the ledger still renders on a partial schema.
const OPTIONAL_COLUMNS = [
  "review_status", "voucher_draws", "duplicate_of",
  "card_paid_amount", "voucher_paid_amount", "voucher_brand_key", "payment_evidence",
];
const PAGE = 1000;

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // The first page's exact count (only requested on that page) tells
  // fetchAllPaginated how many more pages exist, so they can all be fetched
  // in parallel instead of one round-trip at a time (2026-09-04, same fix
  // already applied to /api/transactions/all — a 2500+ row account was
  // paying for 3+ sequential round-trips here alone).
  const optional = [...OPTIONAL_COLUMNS];
  const fetchOrdersPage = (from: number, pageSize: number) =>
    supabase
      .from("orders")
      .select([SAFE_COLUMNS, ...optional].join(", "), from === 0 ? { count: "exact" } : undefined)
      .eq("user_id", user.id)
      .order("order_at", { ascending: false })
      .range(from, from + pageSize - 1) as unknown as Promise<PageResult<Record<string, unknown>>>;

  let result = await fetchAllPaginated(fetchOrdersPage, PAGE);
  // Migration tolerance: drop optional columns one at a time and retry from
  // scratch until the column set works, exactly as before — only page 0 ever
  // needs to renegotiate; once it succeeds, every column is known-good for
  // the whole table, so the remaining pages fetch in parallel with no risk
  // of hitting a different missing-column error partway through.
  while (result.error) {
    if (isMissingTableError(result.error)) {
      return NextResponse.json({ error: "missing_orders_table", orders: [] }, { status: 400 });
    }
    const missing = optional.find((c) => isMissingColumnError(result.error, c));
    if (!missing) {
      return NextResponse.json({ error: result.error.message }, { status: 500 });
    }
    optional.splice(optional.indexOf(missing), 1);
    result = await fetchAllPaginated(fetchOrdersPage, PAGE);
  }

  // Existing Amazon Delivered email rows are hidden immediately. A later
  // Amazon CSV upload also removes them from the database, but this keeps
  // the ledger truthful for users who imported their export previously.
  const all = result.rows.filter((order) => !isObsoleteAmazonDeliveryOrder(order));

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
