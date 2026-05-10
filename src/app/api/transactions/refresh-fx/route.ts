// POST /api/transactions/refresh-fx
//
// Sweeps the user's foreign-currency transactions where amount_inr is 0
// (sentinel for "rate was unavailable when the txn was first written")
// and back-fills the INR equivalent using the historical FX cache + API.
//
// When does amount_inr=0 happen?
//   • Brand-new currency the upstream API doesn't have yet.
//   • CDN was down at sync time.
//   • Txn date < oldest data the API has (rare — covers ~25 years).
//
// This endpoint is idempotent: running it twice in a row is a no-op the
// second time (rates already filled). Concurrency is capped inside
// historical-fx so we don't hammer the free CDN.

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getRatesBulk } from "@/lib/historical-fx";

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // 1. Find rows that need filling. Page through to bypass Supabase's
  //    default 1000-row limit — over multi-year horizons users could
  //    easily have more foreign txns than that.
  const PAGE = 1000;
  const rows: Array<{ id: string; original_currency: string; original_amount: number; txn_at: string; amount_inr: number }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error: selErr } = await supabase
      .from("transactions")
      .select("id, original_currency, original_amount, txn_at, amount_inr")
      .eq("user_id", user.id)
      .neq("original_currency", "INR")
      .or("amount_inr.eq.0,amount_inr.is.null")
      .range(from, from + PAGE - 1);
    if (selErr) {
      return NextResponse.json({ error: `select: ${selErr.message}` }, { status: 500 });
    }
    if (!data || data.length === 0) break;
    rows.push(...data as typeof rows);
    if (data.length < PAGE) break;
  }

  if (rows.length === 0) {
    return NextResponse.json({ updated: 0, message: "Nothing to refresh." });
  }

  // 2. Build the unique (currency, date) pairs we need rates for.
  //    De-dup so we don't fetch the same rate twice.
  const seen = new Set<string>();
  const pairs: Array<{ currency: string; date: Date }> = [];
  for (const r of rows) {
    const code = String(r.original_currency).toUpperCase();
    const date = new Date(r.txn_at);
    const key = `${code}|${date.toISOString().slice(0, 10)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ currency: code, date });
  }

  // 3. Bulk-fetch (cache-aware, concurrency-capped at 5).
  const rates = await getRatesBulk(supabase, pairs);

  // 4. Update each row with its converted amount.
  let updated = 0;
  let skipped = 0;
  for (const r of rows) {
    const code = String(r.original_currency).toUpperCase();
    const date = new Date(r.txn_at);
    const key = `${code}|${date.toISOString().slice(0, 10)}`;
    const rate = rates.get(key);
    if (rate == null) { skipped++; continue; }

    const amount_inr = Math.round(Number(r.original_amount) * rate * 100) / 100;
    const { error: updErr } = await supabase
      .from("transactions")
      .update({ amount_inr })
      .eq("id", r.id);

    if (!updErr) updated++;
  }

  return NextResponse.json({
    scanned: rows.length,
    updated,
    skipped,
    message: skipped > 0
      ? `Updated ${updated}; ${skipped} rows still missing rates (rare currency or unreachable date).`
      : `Updated ${updated} transactions with historical FX rates.`,
  });
}
