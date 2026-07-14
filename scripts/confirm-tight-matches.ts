/**
 * confirm-tight-matches.ts — promote existing PENDING order↔txn matches that
 * the new same-purchase rule (unique exact amount + ≤5 min apart) now treats as
 * HIGH confidence. Mirrors order-match.ts's tight-window auto-confirm for rows
 * matched before that rule existed.
 *
 * READ-ONLY by default; --apply sets review_status='confirmed',
 * match_confidence='high'. Never touches 'confirmed'/'rejected' (human calls).
 * Run:  npx tsx scripts/confirm-tight-matches.ts [--apply]
 */
import { readFileSync } from "fs";
import { join } from "path";
for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const TOL = 0.75;
const TIGHT_MS = 5 * 60 * 1000; // 5 minutes

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  // Pending orders that carry a match (txn_id set), paginated.
  const pending: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("orders")
      .select("id, merchant_name, source, total_amount, order_at, txn_id, match_confidence")
      .eq("review_status", "pending").not("txn_id", "is", null)
      .range(f, f + 999);
    if (error) { console.error(error); process.exit(1); }
    if (!data?.length) break;
    pending.push(...data);
    if (data.length < 1000) break;
  }

  // Fetch the matched txns in one go.
  const txnIds = [...new Set(pending.map((o) => o.txn_id))];
  const txnById = new Map<string, any>();
  for (let i = 0; i < txnIds.length; i += 500) {
    const { data } = await sb.from("transactions").select("id, merchant, amount_inr, txn_at").in("id", txnIds.slice(i, i + 500));
    for (const t of data ?? []) txnById.set(t.id, t);
  }

  const promote = pending.filter((o) => {
    const t = txnById.get(o.txn_id);
    if (!t || o.total_amount == null) return false;
    const amtOk = Math.abs(t.amount_inr - o.total_amount) <= TOL;
    const gapMs = Math.abs(new Date(o.order_at).getTime() - new Date(t.txn_at).getTime());
    return amtOk && gapMs <= TIGHT_MS;
  });

  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${pending.length} pending matched orders; ${promote.length} qualify for auto-confirm (unique exact + ≤5 min)\n`);
  for (const o of promote) {
    const t = txnById.get(o.txn_id);
    const gapS = Math.round(Math.abs(new Date(o.order_at).getTime() - new Date(t.txn_at).getTime()) / 1000);
    console.log(`  ✓ [${o.source}] "${o.merchant_name}" ₹${o.total_amount} ↔ "${t.merchant}"  (${gapS}s apart)  ${o.match_confidence}→high`);
  }

  if (APPLY && promote.length) {
    for (const o of promote) {
      const { error } = await sb.from("orders").update({ review_status: "confirmed", match_confidence: "high" }).eq("id", o.id);
      if (error) console.error(`  ✗ ${o.id}: ${error.message}`);
    }
    console.log(`\nConfirmed ${promote.length} orders.`);
  }
}
main();
