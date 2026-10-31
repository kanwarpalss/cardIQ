/**
 * backfill-missing-fx-rates.ts — one-off runner for backfillMissingFxRates()
 * (src/lib/historical-fx.ts), the same logic POST /api/transactions/refresh-fx
 * uses, run offline via the service-role key instead of an authenticated
 * session. Single-user app, so no user_id filter is applied.
 *
 * READ-ONLY by default. Run:  npx tsx scripts/backfill-missing-fx-rates.ts [--apply]
 */
import { readFileSync } from "fs";
import { join } from "path";
for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { createClient } from "@supabase/supabase-js";
import { backfillMissingFxRates } from "../src/lib/historical-fx";

const APPLY = process.argv.includes("--apply");

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const { data: rows, error } = await sb
    .from("transactions")
    .select("id, original_currency, original_amount, txn_at, amount_inr")
    .neq("original_currency", "INR")
    .or("amount_inr.eq.0,amount_inr.is.null");
  if (error) throw error;

  console.log(`Found ${rows?.length ?? 0} foreign txn(s) missing a historical rate:`);
  for (const r of rows ?? []) {
    console.log(`  ${r.txn_at.slice(0, 10)}  ${r.original_currency} ${r.original_amount}  (id ${r.id})`);
  }

  if (!APPLY) {
    console.log("\nDry run — pass --apply to fetch rates and write amount_inr.");
    return;
  }

  const result = await backfillMissingFxRates(sb);
  console.log("\n" + JSON.stringify(result, null, 2));
}

main();
