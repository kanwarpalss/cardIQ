import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isMissingTableError } from "@/lib/supabase/errors";
import { summarizeVoucherLedger, type LedgerOrder } from "@/lib/voucher-ledger";

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
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // 1) Vouchers.
  const voucherRows: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("vouchers")
      .select("id, code, brand, brand_key, face_value, purchased_at, valid_till, txn_id")
      .eq("user_id", user.id)
      .order("purchased_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) {
      if (isMissingTableError(error)) {
        return NextResponse.json({ error: "missing_vouchers_table", vouchers: [] }, { status: 400 });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data?.length) break;
    voucherRows.push(...(data as Array<Record<string, unknown>>));
    if (data.length < PAGE) break;
  }

  // 2) Orders that drew from vouchers (for the drawdown math + "spent at").
  //    Missing orders table just means no drawdown detail — degrade to [].
  const orderRows: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("orders")
      .select("id, source, merchant_name, order_at, voucher_draws")
      .eq("user_id", user.id)
      .range(from, from + PAGE - 1);
    if (error) break; // missing table / missing column / transient → no enrichment
    if (!data?.length) break;
    orderRows.push(...(data as Array<Record<string, unknown>>));
    if (data.length < PAGE) break;
  }

  const ledgerOrders: LedgerOrder[] = orderRows.map((o) => ({
    id: String(o.id),
    merchant: (o.merchant_name as string) || (o.source as string) || "Unknown",
    orderAt: String(o.order_at ?? ""),
    draws: Array.isArray(o.voucher_draws)
      ? (o.voucher_draws as Array<{ voucherId?: string; amount?: number }>)
          .filter((d) => d && typeof d.voucherId === "string")
          .map((d) => ({ voucherId: d.voucherId as string, amount: Number(d.amount) }))
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
    return {
      id: v.id,
      brand: v.brand,
      brand_key: v.brand_key,
      code: v.code,
      face_value: Number(v.face_value),
      purchased_at: v.purchased_at,
      valid_till: v.valid_till,
      drawn: s.drawn,
      remaining: s.remaining,
      spends: s.spends,
      funding_txn: txn
        ? { card_last4: txn.card_last4, amount_inr: Number(txn.amount_inr), txn_at: txn.txn_at }
        : null,
    };
  });

  return NextResponse.json({ vouchers });
}
