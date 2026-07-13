/**
 * dedup-orders.ts — flag same-purchase duplicate orders (mirrors the sync's
 * dedup pass) so existing rows get de-duplicated without waiting for a sync.
 *
 * READ-ONLY by default; --apply sets duplicate_of + review_status='pending' on
 * duplicates (never overriding a human 'confirmed'/'rejected' decision).
 * Run:  npx tsx scripts/dedup-orders.ts [--apply]
 */
import { readFileSync } from "fs";
import { join } from "path";
for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { createClient } from "@supabase/supabase-js";
import { findDuplicateOrders, type DedupOrder } from "../src/lib/order-dedup";

const APPLY = process.argv.includes("--apply");

async function main() {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase.from("orders")
      .select("id, source, items, total_amount, order_at, txn_id, review_status, merchant_name, raw_subject")
      .range(from, from + 999);
    if (!data?.length) break; rows.push(...data); if (data.length < 1000) break;
  }
  const orders: DedupOrder[] = rows.map((o) => ({
    id: o.id, source: o.source, itemsCount: Array.isArray(o.items) ? o.items.length : 0,
    total_amount: o.total_amount == null ? null : Number(o.total_amount), order_at: o.order_at, txn_id: o.txn_id,
  }));
  const byId = new Map(rows.map((o) => [o.id, o]));

  const dupOf = findDuplicateOrders(orders);
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${rows.length} orders, ${dupOf.size} flagged as duplicates\n`);

  let shown = 0, applied = 0, skipped = 0;
  for (const [dupId, primId] of dupOf) {
    const d = byId.get(dupId), p = byId.get(primId);
    if (shown++ < 15) {
      console.log(`  DUP  [${d.source}] ${(d.merchant_name ?? "?").slice(0, 20).padEnd(20)} ₹${d.total_amount}`);
      console.log(`   └─ of [${p.source}] ${(p.merchant_name ?? "?").slice(0, 20)} (${Array.isArray(p.items) ? p.items.length : 0} items)`);
    }
    // Never override a human decision.
    if (d.review_status === "confirmed" || d.review_status === "rejected") { skipped++; continue; }
    if (APPLY) {
      await supabase.from("orders").update({ duplicate_of: primId, review_status: "pending" }).eq("id", dupId);
      applied++;
    }
  }
  console.log(`\n${APPLY ? `applied to ${applied} orders` : "(dry run)"}; skipped ${skipped} human-decided.`);
}
main();
