import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isMissingTableError } from "@/lib/supabase/errors";
import { summarizeVoucherLedger, type LedgerOrder } from "@/lib/voucher-ledger";
import { fetchAllPaginated, type PageResult } from "@/lib/paginate";

// GET /api/vouchers — the Gyftr voucher ledger (V2 feature C).
//
// Every voucher KP has bought (via Gyftr/SmartBuy), with:
//   • what it's for (brand, face value, code, expiry);
//   • the card charge that funded it (card ••last4, amount paid, date) — the
//     price paid to Gyftr, usually LESS than face value (the reward discount);
//   • how much has been spent from it and how much is LEFT — computed from the
//     drawdowns recorded on orders.voucher_draws (summarizeVoucherLedger).
//
// This is the "which vouchers did I buy, and what's the balance?" screen. The
// data has always existed (populated by the order sync / reconcile-voucher-
// ledger.ts); this route is simply the window onto it. Read-only.
//
// Migration tolerance: no vouchers table (015 not run) → a clear notice, not a
// crash. Missing orders table (011) → vouchers still render, just with no
// drawdown detail (every voucher reads as full).

const PAGE = 1000;

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // The first page's exact count (only requested on that page) tells
  // fetchAllPaginated how many more pages exist, so they can all be fetched
  // in parallel instead of one round-trip at a time (2026-09-04, same fix
  // already applied to /api/transactions/all and /api/orders).

  // 1) Vouchers.
  const fetchVoucherPage = (from: number, pageSize: number) =>
    supabase
      .from("vouchers")
      .select(
        "id, code, brand, brand_key, face_value, purchased_at, valid_till, txn_id, funding_source",
        from === 0 ? { count: "exact" } : undefined
      )
      .eq("user_id", user.id)
      .order("purchased_at", { ascending: false })
      .range(from, from + pageSize - 1) as unknown as Promise<PageResult<Record<string, unknown>>>;

  const voucherResult = await fetchAllPaginated(fetchVoucherPage, PAGE);
  if (voucherResult.error) {
    if (isMissingTableError(voucherResult.error)) {
      return NextResponse.json({ error: "missing_vouchers_table", vouchers: [] }, { status: 400 });
    }
    return NextResponse.json({ error: voucherResult.error.message }, { status: 500 });
  }
  const voucherRows = voucherResult.rows;

  // 2) Orders that drew from vouchers (for the drawdown math + "spent at").
  //    Missing orders table just means no drawdown detail — degrade to [].
  const fetchOrderDrawPage = (from: number, pageSize: number) =>
    supabase
      .from("orders")
      .select("id, source, merchant_name, order_at, voucher_draws", from === 0 ? { count: "exact" } : undefined)
      .eq("user_id", user.id)
      .range(from, from + pageSize - 1) as unknown as Promise<PageResult<Record<string, unknown>>>;

  const orderDrawResult = await fetchAllPaginated(fetchOrderDrawPage, PAGE);
  const orderRows = orderDrawResult.error ? [] : orderDrawResult.rows; // missing table/column/transient → no enrichment

  const ledgerOrders: LedgerOrder[] = orderRows.map((o) => ({
    id: String(o.id),
    merchant: (o.merchant_name as string) || (o.source as string) || "Unknown",
    orderAt: String(o.order_at ?? ""),
    draws: Array.isArray(o.voucher_draws)
      ? (o.voucher_draws as Array<{ voucherId?: string; amount?: number; evidence?: string }>)
          .filter((d) => d && typeof d.voucherId === "string")
          .map((d) => ({ voucherId: d.voucherId as string, amount: Number(d.amount), evidence: d.evidence }))
      : [],
  }));

  const summary = summarizeVoucherLedger(
    voucherRows.map((v) => ({ id: String(v.id), faceValue: Number(v.face_value) })),
    ledgerOrders
  );

  // 3) The funding card charge for each voucher (txn_id → card + amount + date).
  const txnIds = [...new Set(voucherRows.map((v) => v.txn_id).filter(Boolean) as string[])];
  const txnById = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < txnIds.length; i += PAGE) {
    const { data } = await supabase
      .from("transactions")
      .select("id, card_last4, amount_inr, txn_at")
      .eq("user_id", user.id)
      .in("id", txnIds.slice(i, i + PAGE));
    for (const t of data ?? []) txnById.set(t.id as string, t);
  }

  const vouchers = voucherRows.map((v) => {
    const s = summary.get(String(v.id)) ?? { drawn: 0, remaining: Number(v.face_value), spends: [] };
    const txn = v.txn_id ? txnById.get(v.txn_id as string) ?? null : null;
    // "Likely" = every drawdown on this voucher is a best-effort FIFO guess (no
    // receipt/verification behind any of them). The UI dims such a balance so KP
    // knows it's an estimate worth confirming, not a settled fact.
    const likely = s.drawn > 0 && s.spends.length > 0 && s.spends.every((sp) => sp.evidence === "inferred_fifo");
    return {
      id: v.id,
      brand: v.brand,
      brand_key: v.brand_key,
      code: v.code,
      face_value: Number(v.face_value),
      purchased_at: v.purchased_at,
      valid_till: v.valid_till,
      funding_source: v.funding_source ?? "card",
      drawn: s.drawn,
      remaining: s.remaining,
      likely,
      spends: s.spends,
      funding_txn: txn
        ? { card_last4: txn.card_last4, amount_inr: Number(txn.amount_inr), txn_at: txn.txn_at }
        : null,
    };
  });

  return NextResponse.json({ vouchers });
}
