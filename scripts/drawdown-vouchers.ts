/**
 * drawdown-vouchers.ts — run the voucher bridge over existing data (mirrors the
 * sync's Chunk-2 drawdown) so voucher chains populate without waiting for a sync.
 *
 * READ-ONLY by default; --apply writes orders.voucher_draws.
 * Run:  npx tsx scripts/drawdown-vouchers.ts [--apply]
 */
import { readFileSync } from "fs";
import { join } from "path";
for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { createClient } from "@supabase/supabase-js";
import { reconcileVouchers, normalizeBrand, type VoucherPurchase, type VoucherPaidOrder } from "../src/lib/voucher-bridge";

const APPLY = process.argv.includes("--apply");
const MARKETPLACE = new Set(["swiggy", "zomato", "bigbasket", "amazon", "blinkit"]);
const brandKey = (o: any) => normalizeBrand(MARKETPLACE.has(o.source) ? o.source : (o.merchant_name ?? o.source));

async function page(supabase: any, table: string, cols: string, filter: (q: any) => any) {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from(table).select(cols).range(from, from + 999);
    q = filter(q);
    const { data, error } = await q;
    if (error) { console.error(error.message); break; }
    if (!data?.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function main() {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const vouchers = await page(supabase, "vouchers", "id, brand_key, face_value, purchased_at, txn_id", (q) => q);
  const orders = await page(supabase, "orders", "id, source, merchant_name, kind, total_amount, order_at, txn_id, review_status",
    (q) => q.is("txn_id", null).eq("kind", "order"));

  const vps: VoucherPurchase[] = vouchers.map((v) => ({
    id: v.id, brand: v.brand_key, faceValue: Number(v.face_value), purchasedAt: v.purchased_at, cardTxnId: v.txn_id,
  }));
  const brands = new Set(vps.map((v) => v.brand));
  const vpos: VoucherPaidOrder[] = orders
    .filter((o) => o.total_amount != null && brands.has(brandKey(o)))
    .map((o) => ({ id: o.id, brand: brandKey(o), amount: Number(o.total_amount), orderedAt: o.order_at }));

  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${vps.length} vouchers, ${vpos.length} candidate orders (brands with vouchers)\n`);
  const bridge = reconcileVouchers(vps, vpos);
  const linked = bridge.orders.filter((a) => a.draws.length > 0);
  const byBrand: Record<string, number> = {};
  for (const a of linked) byBrand[a.brand] = (byBrand[a.brand] ?? 0) + 1;
  console.log(`orders traced to a voucher: ${linked.length}`);
  console.log("by brand:", byBrand);
  const recon = bridge.vouchers.filter((v) => v.reconciled).length;
  console.log(`vouchers (almost) fully drawn down: ${recon}/${bridge.vouchers.length}`);

  if (APPLY) {
    let n = 0;
    for (const a of linked) {
      await supabase.from("orders").update({ voucher_draws: a.draws }).eq("id", a.orderId);
      n++;
    }
    console.log(`\nAPPLIED voucher_draws to ${n} orders.`);
  } else {
    console.log(`\n(dry run — nothing written. --apply to write.)`);
  }
}
main();
