/**
 * import-amazon.ts — load Amazon order history into CardIQ.
 *
 * 1. amazon.in → Account → "Request Your Information" → select "Your Orders".
 * 2. Amazon emails a ZIP (usually within hours). Unzip it.
 * 3. Run:  npx tsx scripts/import-amazon.ts --file <path-to>/Retail.OrderHistory.1.csv
 *          (add --apply to write; default is a dry run that just reports)
 *
 * Imported orders get source='amazon', a synthetic gmail_message_id
 * ("amazon-csv:<orderId>") so re-imports upsert instead of duplicating, and
 * review_status='unmatched'. Run an Orders sync afterwards to match them to
 * card charges (the sync's dedup will also collapse any that overlap an
 * email-sourced Amazon order sharing the same order_ref).
 */
import { readFileSync } from "fs";
import { join } from "path";
for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { createClient } from "@supabase/supabase-js";
import { parseAmazonOrderHistory } from "../src/lib/imports/amazon-csv";

const APPLY = process.argv.includes("--apply");
const fileArg = process.argv[process.argv.indexOf("--file") + 1];

async function main() {
  if (!fileArg || fileArg.startsWith("--")) {
    console.error("Usage: npx tsx scripts/import-amazon.ts --file <Retail.OrderHistory.1.csv> [--apply]");
    process.exit(1);
  }
  const csv = readFileSync(fileArg, "utf8");
  const orders = parseAmazonOrderHistory(csv);
  console.log(`Parsed ${orders.length} Amazon orders (${orders.reduce((n, o) => n + o.items.length, 0)} items) from ${fileArg}`);
  if (orders.length === 0) { console.log("Nothing to import — is this the Retail.OrderHistory CSV?"); return; }

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: settings } = await sb.from("user_settings").select("user_id").limit(1).single();
  const userId = settings!.user_id;

  // Skip orders already present (by order_ref) — from a prior import or email sync.
  const existing = new Set<string>();
  for (let f = 0; ; f += 1000) {
    const { data } = await sb.from("orders").select("order_ref").eq("user_id", userId).eq("source", "amazon").range(f, f + 999);
    if (!data?.length) break;
    for (const r of data) if (r.order_ref) existing.add(r.order_ref);
    if (data.length < 1000) break;
  }
  const fresh = orders.filter((o) => !existing.has(o.orderRef));
  console.log(`${fresh.length} new, ${orders.length - fresh.length} already in CardIQ (skipped).`);
  for (const o of fresh.slice(0, 8)) console.log(`  ${o.orderedAt.slice(0, 10)} ₹${o.total} — ${o.items.map((i) => i.name).join(", ").slice(0, 90)}`);

  if (!APPLY) { console.log("\n(dry run — nothing written. Re-run with --apply.)"); return; }

  const rows = fresh.map((o) => ({
    user_id: userId, source: "amazon", kind: "order",
    gmail_message_id: `amazon-csv:${o.orderRef}`, order_ref: o.orderRef,
    merchant_name: o.merchant, total_amount: o.total, order_at: o.orderedAt,
    items: o.items, raw_subject: `Amazon order ${o.orderRef}`, review_status: "unmatched",
  }));
  let ok = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from("orders").upsert(rows.slice(i, i + 500), { onConflict: "user_id,gmail_message_id" });
    if (error) console.error("  upsert error:", error.message); else ok += Math.min(500, rows.length - i);
  }
  console.log(`Imported ${ok} orders. Now run an Orders sync in the app to match them to card charges.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
