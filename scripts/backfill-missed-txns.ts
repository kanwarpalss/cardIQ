/**
 * backfill-missed-txns.ts — offline equivalent of /api/gmail/reprocess's
 * Phase A, runnable without a browser session. For every
 * gmail_seen_messages row with txn_id IS NULL and a stored raw_body,
 * re-runs the SAME parseTxnEmailWithFallback the live sync/reprocess routes
 * use, and inserts whatever newly parses.
 *
 * Exists so a parser fix can be verified against real synced data (TEST-02)
 * and backfilled without needing an authenticated HTTP request — reuses the
 * shared enrichAmount/categorize/cleanMerchant chokepoints so it can never
 * disagree with the live write paths (see txn-enrich.ts's header comment
 * for why that file exists).
 *
 * READ-ONLY by default. Run:  npx tsx scripts/backfill-missed-txns.ts [--apply]
 */
import { readFileSync } from "fs";
import { join } from "path";
for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { createClient } from "@supabase/supabase-js";
import { parseTxnEmailWithFallback, type ParsedTxn } from "../src/lib/parsers/registry";
import { loadExcludedMessageIds } from "../src/lib/excluded-messages";
import { categorizeFull } from "../src/lib/categorize";
import { resolveTxnCategory } from "../src/lib/category-taxonomy";
import { loadCategoryAliases } from "../src/lib/category-taxonomy-store";
import { cleanMerchant } from "../src/lib/merchant-clean";
import { enrichAmount } from "../src/lib/txn-enrich";
import { normalizeMojibake } from "../src/lib/gmail/mail-source";

const APPLY = process.argv.includes("--apply");
const PAGE = 1000;

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: s } = await sb.from("user_settings").select("user_id").limit(1).single();
  const uid = s!.user_id as string;

  const [cardsRes, mappingsRes] = await Promise.all([
    sb.from("cards").select("id, last4").eq("user_id", uid),
    sb.from("merchant_mappings").select("raw_name, normalized_name, category").eq("user_id", uid),
  ]);
  const cardByLast4 = new Map((cardsRes.data || []).map((c) => [c.last4, c.id]));
  const knownLast4s = new Set((cardsRes.data || []).map((c) => c.last4));
  const excludedIds = await loadExcludedMessageIds(sb, uid);
  const merchantMap = new Map((mappingsRes.data || []).map((m) => [m.raw_name.toLowerCase(), m]));
  const categoryAliases = await loadCategoryAliases(sb, uid);

  type Row = { gmail_message_id: string; raw_subject: string; raw_body: string; raw_from: string; internal_date: number | null };
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("gmail_seen_messages")
      .select("gmail_message_id, raw_subject, raw_body, raw_from, internal_date")
      .eq("user_id", uid)
      .is("txn_id", null)
      .not("raw_body", "is", null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...(data as Row[]));
    if (data.length < PAGE) break;
  }

  console.log(`Scanning ${rows.length} unmatched emails with stored bodies...`);

  let newlyParsed = 0;
  const samples: string[] = [];

  for (const row of rows) {
    // Older app builds stored undecodable separator bytes as U+FFFD. Apply
    // the same normalization as current IMAP ingestion before retrying them.
    const subject = normalizeMojibake(row.raw_subject || "");
    const body = normalizeMojibake(row.raw_body || "");
    // A statement proved this email was never a charge (migration 023).
    const parsed = excludedIds.has(row.gmail_message_id) ? null : parseTxnEmailWithFallback(row.raw_from || "", subject, body, "", knownLast4s);
    if (!parsed) continue;
    newlyParsed++;

    const cardId = cardByLast4.get(parsed.card_last4) ?? null;
    const rawKey = parsed.merchant_raw?.toLowerCase() ?? "";
    const cleaned = cleanMerchant(parsed.merchant_raw);
    const cleanedK = cleaned?.toLowerCase() ?? "";
    const mapping = (rawKey && merchantMap.get(rawKey)) || (cleanedK && merchantMap.get(cleanedK)) || null;
    const merchant = mapping?.normalized_name ?? cleaned ?? null;
    const { category } = resolveTxnCategory(mapping, categorizeFull(merchant), categoryAliases);
    const txnAt = row.internal_date ? new Date(row.internal_date) : parsed.txn_at;

    if (samples.length < 20) {
      samples.push(`  [${txnAt.toISOString().slice(0, 10)}] ${parsed.txn_type} ₹${parsed.amount_inr} ${merchant ?? "(no merchant)"} — card ...${parsed.card_last4}${parsed.low_confidence ? " [low-confidence]" : ""}`);
    }

    if (!APPLY) continue;

    const enriched = await enrichAmount(sb, parsed as ParsedTxn, txnAt);
    const { data: upserted, error: upsertErr } = await sb
      .from("transactions")
      .upsert(
        {
          user_id: uid,
          card_id: cardId,
          card_last4: parsed.card_last4,
          amount_inr: enriched.amount_inr,
          original_currency: enriched.original_currency,
          original_amount: enriched.original_amount,
          low_confidence: parsed.low_confidence ?? false,
          merchant,
          category,
          txn_type: parsed.txn_type,
          txn_at: txnAt.toISOString(),
          gmail_message_id: row.gmail_message_id,
          raw_subject: subject,
          raw_body: body,
        },
        { onConflict: "user_id,gmail_message_id" }
      )
      .select("id")
      .maybeSingle();

    if (upsertErr) {
      throw new Error(`upsert failed for ${row.gmail_message_id}: ${upsertErr.message}`);
    }

    if (!upserted?.id) throw new Error(`No transaction returned for ${row.gmail_message_id}`);
    const { error: linkErr } = await sb.from("gmail_seen_messages")
      .update({ txn_id: upserted.id, raw_subject: subject, raw_body: body })
      .eq("user_id", uid).eq("gmail_message_id", row.gmail_message_id);
    if (linkErr) throw new Error(`link failed for ${row.gmail_message_id}: ${linkErr.message}`);
  }

  console.log(`\n${newlyParsed} email(s) now parse as transactions (were previously unmatched).`);
  if (samples.length) {
    console.log(`Sample${newlyParsed > samples.length ? ` (first ${samples.length})` : ""}:`);
    console.log(samples.join("\n"));
  }
  console.log(APPLY ? "\nAPPLIED — rows inserted/updated in the live database." : "\nDRY RUN — nothing written. Re-run with --apply to insert.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
