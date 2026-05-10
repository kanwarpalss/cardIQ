import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { toInr, RATES_AS_OF } from "@/lib/forex";

/**
 * Spend aggregator with strict currency separation.
 *
 * Why the rewrite: pre-fix, foreign-currency transactions had their original
 * amounts (USD/IDR/etc.) stored verbatim in `amount_inr`, so summing them
 * inflated INR totals catastrophically (a single IDR 12,272,062 hotel stay
 * looked like ₹1.2 crore). This route now:
 *
 *   1. Splits transactions into `inr_transactions` (currency = 'INR' or
 *      legacy NULL) and `foreign_transactions` (everything else).
 *   2. ALL aggregates (totals, by_merchant, by_category, per-card totals)
 *      include ONLY inr_transactions. The dashboard's "₹X spent" numbers
 *      are now currency-pure.
 *   3. Returns a `foreign_currency_breakdown` per ISO code with the native
 *      total + an estimated INR equivalent (using the static forex table)
 *      so the user can see at a glance "you spent IDR 12.3M ≈ ₹65k abroad".
 */
export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const now = new Date();

  const fromParam     = url.searchParams.get("from");
  const toParam       = url.searchParams.get("to");
  const cardsParam    = url.searchParams.get("cards");
  const typeParam     = url.searchParams.get("txn_type");
  const search        = url.searchParams.get("q")?.trim().toLowerCase() || "";
  const categoryParam = url.searchParams.get("category");

  const from = fromParam ? new Date(fromParam) : new Date(now.getFullYear(), now.getMonth(), 1);
  const to   = toParam   ? new Date(toParam)   : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

  const { data: cards } = await supabase
    .from("cards")
    .select("id, last4, nickname, product_key")
    .eq("user_id", user.id);

  const { data: settings } = await supabase
    .from("user_settings")
    .select("last_gmail_sync_at")
    .eq("user_id", user.id)
    .single();

  let query = supabase
    .from("transactions")
    .select("card_last4, amount_inr, original_currency, original_amount, merchant, category, txn_at, txn_type, card_id")
    .eq("user_id", user.id)
    .gte("txn_at", from.toISOString())
    .lte("txn_at", to.toISOString())
    .order("txn_at", { ascending: false });

  const selectedLast4s = cardsParam && cardsParam !== "all"
    ? cardsParam.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  if (selectedLast4s?.length)                              query = query.in("card_last4", selectedLast4s);
  if (typeParam === "debit" || typeParam === "credit")     query = query.eq("txn_type", typeParam);
  if (categoryParam)                                       query = query.eq("category", categoryParam);
  if (search)                                              query = query.ilike("merchant", `%${search}%`);

  const { data: txns } = await query;
  const allTxns = txns || [];

  // ── Currency split ────────────────────────────────────────────────────────
  // INR txns: original_currency is 'INR' OR null (legacy rows with no
  // currency tagging — assume INR since pre-multi-currency parsers only
  // produced INR rows).
  const isInr = (t: { original_currency: string | null }) =>
    !t.original_currency || t.original_currency.toUpperCase() === "INR";

  const inrTxns     = allTxns.filter(isInr);
  const foreignTxns = allTxns.filter((t) => !isInr(t));

  // ── INR-only aggregates ───────────────────────────────────────────────────
  const debits  = inrTxns.filter((t) => t.txn_type === "debit");
  const credits = inrTxns.filter((t) => t.txn_type === "credit");

  const total_debit  = debits.reduce((s, t) => s + Number(t.amount_inr), 0);
  const total_credit = credits.reduce((s, t) => s + Number(t.amount_inr), 0);

  const totals: Record<string, number> = {};
  for (const t of debits) totals[t.card_last4] = (totals[t.card_last4] || 0) + Number(t.amount_inr);

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

  // ── Foreign-currency breakdown ────────────────────────────────────────────
  // Group by ISO code, sum natively. INR estimate uses the static rate table
  // — surfaced as `inr_estimate` so the UI can show both "IDR 12.3M" and
  // "≈ ₹65,000" side by side without forcing the user to do mental math.
  const foreignMap: Record<string, {
    currency: string;
    total_original: number;
    debit_count: number;
    credit_count: number;
    inr_estimate: number | null;
  }> = {};
  for (const t of foreignTxns) {
    const code = (t.original_currency || "???").toUpperCase();
    const amt  = Number(t.original_amount ?? 0);
    if (!foreignMap[code]) {
      foreignMap[code] = { currency: code, total_original: 0, debit_count: 0, credit_count: 0, inr_estimate: 0 };
    }
    const entry = foreignMap[code];
    if (t.txn_type === "credit") {
      entry.total_original -= amt;
      entry.credit_count++;
    } else {
      entry.total_original += amt;
      entry.debit_count++;
    }
  }
  // Compute INR estimate per group AFTER summing (cheaper than per-row).
  for (const code of Object.keys(foreignMap)) {
    const entry = foreignMap[code];
    entry.inr_estimate = toInr(entry.total_original, code);
  }
  const foreign_currency_breakdown = Object.values(foreignMap)
    .sort((a, b) => (b.inr_estimate ?? 0) - (a.inr_estimate ?? 0));

  return NextResponse.json({
    from: from.toISOString(),
    to:   to.toISOString(),
    summary: {
      total_debit,
      total_credit,
      net: total_debit - total_credit,
      txn_count:    inrTxns.length,
      debit_count:  debits.length,
      credit_count: credits.length,
      // Foreign txns counted separately so the user knows they exist even
      // if they're not in the INR totals.
      foreign_txn_count: foreignTxns.length,
    },
    by_merchant,
    by_category,
    totals,
    transactions:         inrTxns,
    foreign_transactions: foreignTxns,
    foreign_currency_breakdown,
    forex_rates_as_of:    RATES_AS_OF,
    cards:                cards || [],
    last_sync:            settings?.last_gmail_sync_at ?? null,
  });
}
