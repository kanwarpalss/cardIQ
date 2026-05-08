import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Returns ALL transactions for the user. Client filters/aggregates from this.
// Pages internally to avoid Supabase's 1000-row default limit.

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const PAGE = 1000;
  const all: Array<Record<string, unknown>> = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("transactions")
      .select("id, card_last4, amount_inr, merchant, category, txn_at, txn_type, card_id, notes")
      .eq("user_id", user.id)
      .order("txn_at", { ascending: false })
      .range(from, from + PAGE - 1);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data?.length) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const [{ data: cards }, { data: settings }] = await Promise.all([
    supabase.from("cards").select("id, last4, nickname, product_key").eq("user_id", user.id),
    supabase.from("user_settings").select("last_gmail_sync_at").eq("user_id", user.id).single(),
  ]);

  return NextResponse.json({
    transactions: all,
    cards: cards || [],
    last_sync: settings?.last_gmail_sync_at ?? null,
  });
}
