/**
 * reparse-orders.ts — re-run the CURRENT parsers over already-synced order
 * emails and heal the stored rows with recovered item detail.
 *
 * Parsers improve (Swiggy Format B, Shopify HTML, …) but existing `orders` rows
 * keep whatever the OLD parser stored. This re-fetches each order's email by
 * gmail_message_id, re-parses with today's code, and updates items/total/
 * merchant — WITHOUT touching txn_id / review_status / match_confidence (the
 * match + your review decisions are preserved).
 *
 * READ-ONLY by default (dry run). Pass --apply to write.
 *
 * Run:  npx tsx scripts/reparse-orders.ts          (dry run)
 *       npx tsx scripts/reparse-orders.ts --apply   (write)
 */
import { readFileSync } from "fs";
import { join } from "path";
for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import { decrypt } from "../src/lib/crypto";
import { makeGmailOAuthClient, extractBody, extractHtml } from "../src/lib/gmail/extract";
import { parseOrderEmail } from "../src/lib/parsers/orders/registry";

const APPLY = process.argv.includes("--apply");

async function main() {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: settings } = await supabase
    .from("user_settings").select("user_id, google_refresh_token_encrypted").limit(1).single();
  const auth = makeGmailOAuthClient();
  auth.setCredentials({ refresh_token: decrypt(settings!.google_refresh_token_encrypted) });
  const gmail = google.gmail({ version: "v1", auth });

  const orders: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase
      .from("orders").select("id, gmail_message_id, source, items, txn_id, review_status, raw_subject")
      .range(from, from + 999);
    if (!data?.length) break;
    orders.push(...data);
    if (data.length < 1000) break;
  }
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — re-parsing ${orders.length} orders…\n`);

  // Stale rows we DELETE on apply: pure shipping-status pings that were stored
  // as orders before the guard existed (they carry a total and double-count in
  // the ledger). Deliberately EXCLUDES bare "delivered" so real delivery
  // receipts (Instamart, Swiggy) are spared — only clear in-transit pings go.
  const STRICT_SHIPPING_RE = /on its way|at your doorstep|has shipped|out for delivery|shipment|shipping update|is on the way/i;

  let gained = 0, gainedItems = 0, nowNull = 0, deleted = 0, unchanged = 0, errors = 0;
  const nullSamples: string[] = [];
  const gainSamples: string[] = [];

  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    if (i % 100 === 0) process.stderr.write(`  …${i}/${orders.length}\n`);
    try {
      const full = await gmail.users.messages.get({ userId: "me", id: o.gmail_message_id, format: "full" });
      const headers = full.data.payload?.headers || [];
      const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
      const from = headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
      const text = extractBody(full.data.payload);
      const html = extractHtml(full.data.payload);
      const parsed = parseOrderEmail(from, subject, text, html);

      const oldN = Array.isArray(o.items) ? o.items.length : 0;
      if (!parsed) {
        // No longer an order (e.g. shipping-status now correctly rejected).
        nowNull++;
        if (nullSamples.length < 12) nullSamples.push(`[${o.source}] ${(o.raw_subject ?? "").slice(0, 55)}`);
        // Purge clear shipping-status pings (they double-count) — but only if
        // unmatched, so a human-reviewed link is never silently destroyed.
        if (APPLY && !o.txn_id && STRICT_SHIPPING_RE.test(o.raw_subject ?? "")) {
          await supabase.from("orders").delete().eq("id", o.id);
          deleted++;
        }
        continue;
      }
      const newN = parsed.items.length;
      if (newN > oldN) {
        gained++;
        gainedItems += newN - oldN;
        if (gainSamples.length < 12) gainSamples.push(`[${parsed.source}] +${newN} items — ${(o.raw_subject ?? "").slice(0, 45)}`);
        if (APPLY) {
          await supabase.from("orders").update({
            items: parsed.items,
            merchant_name: parsed.merchant_name ?? null,
            total_amount: parsed.total_amount ?? null,
            source: parsed.source,
          }).eq("id", o.id);
        }
      } else {
        unchanged++;
      }
    } catch (e) {
      errors++;
    }
  }

  console.log(`\n── ${APPLY ? "APPLIED" : "DRY RUN"} ──`);
  console.log(`orders that GAIN item detail : ${gained}  (+${gainedItems} item rows)`);
  console.log(`orders now parse to NULL     : ${nowNull}  (shipping-status / unparseable)`);
  console.log(`  of which DELETED (strict shipping, unmatched): ${deleted}`);
  console.log(`unchanged                    : ${unchanged}`);
  console.log(`fetch errors                 : ${errors}`);
  console.log(`\nSample GAINED:\n  ${gainSamples.join("\n  ")}`);
  console.log(`\nSample NULL (would-delete):\n  ${nullSamples.join("\n  ")}`);
  if (!APPLY) console.log(`\n(dry run — nothing written. Re-run with --apply to heal.)`);
}
main();
