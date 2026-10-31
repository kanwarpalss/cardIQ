// GET /api/fx/today
//
// Live "1 unit = N INR" rate for every foreign currency the user actually
// has transactions in, as of today. Goes through the same cache → upstream
// → ±7-day-fallback pipeline as historical conversions (historical-fx.ts) —
// "today" is just another date, so this self-updates every calendar day.
// Replaces the old hardcoded RATES table + manually-bumped RATES_AS_OF
// constant in src/lib/forex.ts for the Foreign Currency panel's "today's
// rate" column (forex.ts's static table itself stays, used only by the
// orphaned /api/spend route — see SPEC.md).

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getTodayRates } from "@/lib/historical-fx";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const PAGE = 1000;
  const currencies = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("transactions")
      .select("original_currency")
      .eq("user_id", user.id)
      .neq("original_currency", "INR")
      .not("original_currency", "is", null)
      .range(from, from + PAGE - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;
    for (const r of data) if (r.original_currency) currencies.add(r.original_currency.toUpperCase());
    if (data.length < PAGE) break;
  }

  if (currencies.size === 0) {
    return NextResponse.json({ asOf: new Date().toISOString().slice(0, 10), rates: {} });
  }

  const result = await getTodayRates(supabase, Array.from(currencies));
  return NextResponse.json(result);
}
