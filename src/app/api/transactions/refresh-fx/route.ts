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
import { backfillMissingFxRates } from "@/lib/historical-fx";

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const result = await backfillMissingFxRates(supabase, { userId: user.id });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "refresh failed" }, { status: 500 });
  }
}
