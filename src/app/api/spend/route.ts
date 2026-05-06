import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const now = new Date();

  const fromParam = url.searchParams.get("from");
  const toParam   = url.searchParams.get("to");
  const cardsParam = url.searchParams.get("cards"); // comma-separated last4s, or "all"
  const typeParam  = url.searchParams.get("txn_type"); // "debit" | "credit" | "all"
  const search     = url.searchParams.get("q")?.trim().toLowerCase() || ""; // merchant text search
  const categoryParam = url.searchParams.get("category"); // optional single-category filter

  const from = fromParam
    ? new Date(fromParam)
    : new Date(now.getFullYear(), now.getMonth(), 1);
  const to = toParam
    ? new Date(toParam)
    : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

  const { data: cards } = await supabase
    .from("cards")
    .select("id, last4, nickname, product_key")
    .eq("user_id", user.id);

  const { data: settings } = await supabase
    .from("user_settings")
    .select("last_gmail_sync_at")
    .eq("user_id", user.id)
    .single();

  // Build transaction query with filters
  let query = supabase
    .from("transactions")
    .select("card_last4, amount_inr, merchant, category, txn_at, txn_type, card_id")
    .eq("user_id", user.id)
    .gte("txn_at", from.toISOString())
    .lte("txn_at", to.toISOString())
    .order("txn_at", { ascending: false });

  // Card filter
  const selectedLast4s = cardsParam && cardsParam !== "all"
    ? cardsParam.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  if (selectedLast4s?.length) {
    query = query.in("card_last4", selectedLast4s);
  }

  // Transaction type filter
  if (typeParam === "debit" || typeParam === "credit") {
    query = query.eq("txn_type", typeParam);
  }

  // Category filter (used when user clicks a category bar)
  if (categoryParam) {
    query = query.eq("category", categoryParam);
  }

  // Merchant text search
  if (search) {
    query = query.ilike("merchant", `%${search}%`);
  }

  const { data: txns } = await query;
  const transactions = txns || [];

  // --- Aggregations ---

  const debits  = transactions.filter((t) => t.txn_type === "debit");
  const credits = transactions.filter((t) => t.txn_type === "credit");

  const total_debit  = debits.reduce((s, t) => s + Number(t.amount_inr), 0);
  const total_credit = credits.reduce((s, t) => s + Number(t.amount_inr), 0);

  // Per-card totals (debits only for milestone tracking)
  const totals: Record<string, number> = {};
  for (const t of debits) {
    totals[t.card_last4] = (totals[t.card_last4] || 0) + Number(t.amount_inr);
  }

  // By merchant (debits only, sorted by total desc)
  const merchantMap: Record<string, { total: number; count: number; category: string }> = {};
  for (const t of debits) {
    const key = t.merchant || "Unknown";
    if (!merchantMap[key]) merchantMap[key] = { total: 0, count: 0, category: t.category || "Other" };
    merchantMap[key].total += Number(t.amount_inr);
    merchantMap[key].count++;
  }
  const by_merchant = Object.entries(merchantMap)
    .map(([merchant, v]) => ({ merchant, ...v }))
    .sort((a, b) => b.total - a.total);

  // By category (debits only, sorted by total desc)
  const categoryMap: Record<string, { total: number; count: number }> = {};
  for (const t of debits) {
    const key = t.category || "Other";
    if (!categoryMap[key]) categoryMap[key] = { total: 0, count: 0 };
    categoryMap[key].total += Number(t.amount_inr);
    categoryMap[key].count++;
  }
  const by_category = Object.entries(categoryMap)
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => b.total - a.total);

  return NextResponse.json({
    from: from.toISOString(),
    to: to.toISOString(),
    summary: {
      total_debit,
      total_credit,
      net: total_debit - total_credit,
      txn_count: transactions.length,
      debit_count: debits.length,
      credit_count: credits.length,
    },
    by_merchant,
    by_category,
    totals,
    transactions,
    cards: cards || [],
    last_sync: settings?.last_gmail_sync_at ?? null,
  });
}
