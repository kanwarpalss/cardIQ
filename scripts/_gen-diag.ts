/** READ-ONLY: profile generic/razorpay orders — merchants, item-ability, GoRally. */
import { readFileSync } from "fs";
import { join } from "path";
for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { createClient } from "@supabase/supabase-js";

async function main() {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const all: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase.from("orders")
      .select("source, merchant_name, raw_subject, gmail_message_id, items").in("source", ["generic", "razorpay"]).range(from, from + 999);
    if (!data?.length) break; all.push(...data); if (data.length < 1000) break;
  }

  // Group generic/razorpay by merchant.
  const byMerch: Record<string, { n: number; withItems: number; sample: string }> = {};
  for (const o of all) {
    const k = `${o.source}|${(o.merchant_name ?? "?").slice(0, 30)}`;
    byMerch[k] ??= { n: 0, withItems: 0, sample: o.raw_subject ?? "" };
    byMerch[k].n++;
    if (Array.isArray(o.items) && o.items.length) byMerch[k].withItems++;
  }
  console.log("TOP merchants in generic/razorpay (count ≥ 2):\n");
  for (const [k, v] of Object.entries(byMerch).sort((a, b) => b[1].n - a[1].n).slice(0, 40)) {
    if (v.n < 2) continue;
    console.log(`${String(v.n).padStart(4)}  items:${v.withItems}  ${k.padEnd(40)}  e.g. ${v.sample.slice(0, 40)}`);
  }

  // GoRally hunt.
  const gorally = all.filter((o) => /rally|pickle/i.test(`${o.merchant_name} ${o.raw_subject}`));
  console.log(`\n\nGoRally / pickleball matches: ${gorally.length}`);
  for (const o of gorally.slice(0, 8)) console.log(`  [${o.source}] ${o.merchant_name} — ${o.raw_subject?.slice(0, 55)}`);

  // Dump a few real generic bodies to see item structure.
  const pickIds = [
    all.find((o) => /apple/i.test(o.merchant_name ?? ""))?.gmail_message_id,
    all.find((o) => /rally|pickle/i.test(`${o.merchant_name} ${o.raw_subject}`))?.gmail_message_id,
    all.find((o) => /eazy|zomato|dineout|district/i.test(o.merchant_name ?? ""))?.gmail_message_id,
  ].filter(Boolean);
  for (const id of pickIds) {
    const { data: seen } = await supabase.from("gmail_seen_messages").select("raw_subject, raw_from, raw_body").eq("gmail_message_id", id).limit(1);
    const s = seen?.[0]; if (!s) continue;
    console.log(`\n\n==== ${s.raw_from} | ${s.raw_subject} ====\n${(s.raw_body ?? "").slice(0, 1100)}`);
  }
}
main();
