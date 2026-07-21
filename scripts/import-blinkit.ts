/**
 * import-blinkit.ts — load Blinkit order history into CardIQ from the JSON its
 * web app returns (Blinkit has no order emails and no official export).
 *
 * Get the JSON one of two ways:
 *   A. scripts/blinkit-fetch.ts  (pages the order-history API with your cookie)
 *   B. DevTools: open blinkit.com → My Orders, open the Network tab, find the
 *      "orders" XHR, right-click → Copy → Copy response, save it to a .json file.
 *
 * blinkit-fetch.ts includes per-order detail responses automatically. For a
 * manually-captured detail file, pass it too:
 *   npx tsx scripts/import-blinkit.ts --file blinkit-orders.json --details-file blinkit-details.json [--apply]
 *
 * The parser is shape-tolerant but Blinkit's JSON isn't documented — if items
 * come through empty, send me the JSON and I'll tune the field aliases in
 * src/lib/imports/blinkit-json.ts.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { createClient } from "@supabase/supabase-js";
import { mergeBlinkitOrders, parseBlinkitOrderDetails, parseBlinkitOrders } from "../src/lib/imports/blinkit-json";

const APPLY = process.argv.includes("--apply");
const flagValue = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const fileArg = flagValue("--file");
const detailsArg = flagValue("--details-file");

async function main() {
  if (!fileArg || fileArg.startsWith("--")) {
    console.error("Usage: npx tsx scripts/import-blinkit.ts --file <orders.json> [--apply]");
    process.exit(1);
  }
  if (!existsSync(fileArg)) {
    console.error(`Cannot find ${fileArg}. The Blinkit fetch did not succeed, so there is nothing to import yet. Fix the fetch first, then rerun this command.`);
    process.exit(1);
  }
  const captured = JSON.parse(readFileSync(fileArg, "utf8"));
  const history = parseBlinkitOrders(captured);
  const details = detailsArg && !detailsArg.startsWith("--")
    ? parseBlinkitOrderDetails(JSON.parse(readFileSync(detailsArg, "utf8")))
    : parseBlinkitOrderDetails(captured);
  const orders = mergeBlinkitOrders(history, details);
  console.log(`Parsed ${orders.length} Blinkit orders (${orders.reduce((n, o) => n + o.items.length, 0)} items; ${details.length} full detail response${details.length === 1 ? "" : "s"}).`);
  if (orders.length === 0) { console.log("No orders found — the JSON shape may differ; send it over and I'll tune the parser."); return; }
  for (const o of orders.slice(0, 8)) console.log(`  ${o.orderedAt.slice(0, 10)} ₹${o.total} — ${o.items.map((i) => i.name).join(", ").slice(0, 90)}`);

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: settings } = await sb.from("user_settings").select("user_id").limit(1).single();
  const userId = settings!.user_id;

  if (!APPLY) { console.log("\n(dry run — nothing written. Re-run with --apply.)"); return; }

  const rows = orders.map((o) => ({
    user_id: userId, source: "blinkit", kind: "order",
    gmail_message_id: `blinkit-json:${o.orderRef}`, order_ref: o.orderRef,
    merchant_name: o.merchant, total_amount: o.total, order_at: o.orderedAt,
    items: o.items, raw_subject: `Blinkit order ${o.orderRef}`, review_status: "unmatched",
  }));
  let ok = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from("orders").upsert(rows.slice(i, i + 500), { onConflict: "user_id,gmail_message_id" });
    if (error) console.error("  upsert error:", error.message); else ok += Math.min(500, rows.length - i);
  }
  console.log(`Imported ${ok} orders. Run an Orders sync in the app to match them to card charges.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
