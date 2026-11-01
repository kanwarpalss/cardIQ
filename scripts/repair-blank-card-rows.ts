/**
 * repair-blank-card-rows.ts — the HDFC legacy branch used to store "" as the
 * card when an alert said "Card XX5906" rather than "ending 5906", which hid
 * those charges from every card's totals. Re-parses each such row from its own
 * stored email and fills in the card. Touches nothing but card_last4 and card_id.
 *
 * READ-ONLY by default. Run:  npx tsx scripts/repair-blank-card-rows.ts [--apply]
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { parseHdfcTxn } from "../src/lib/parsers/hdfc";

const APPLY = process.argv.includes("--apply");

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: rows, error } = await sb
    .from("transactions")
    .select("id, user_id, amount_inr, txn_type, raw_subject, raw_body, merchant")
    .or("card_last4.is.null,card_last4.eq.");
  if (error) throw new Error(error.message);
  console.log(`${rows.length} row(s) with no card`);

  for (const r of rows) {
    const parsed = parseHdfcTxn(r.raw_subject ?? "", r.raw_body ?? "");
    // Only a re-parse that agrees on the money may touch the row.
    if (!parsed || parsed.amount_inr !== Number(r.amount_inr) || parsed.txn_type !== r.txn_type) {
      console.log(`  SKIP ${r.id}: ₹${r.amount_inr} ${r.merchant} — the email doesn't re-parse to the same charge`);
      continue;
    }
    const { data: card } = await sb.from("cards").select("id").eq("user_id", r.user_id).eq("last4", parsed.card_last4).maybeSingle();
    console.log(`  ${APPLY ? "SET " : "WOULD SET"} ₹${r.amount_inr} ${r.merchant} → card ${parsed.card_last4}${card ? " (registered)" : " (retired card, no card row)"}`);
    if (!APPLY) continue;
    const { error: upErr } = await sb.from("transactions")
      .update({ card_last4: parsed.card_last4, card_id: card?.id ?? null })
      .eq("id", r.id);
    if (upErr) throw new Error(upErr.message);
  }
  console.log(APPLY ? "\nAPPLIED." : "\nDRY RUN — nothing written. Re-run with --apply to write.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
