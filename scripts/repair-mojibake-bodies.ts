/**
 * repair-mojibake-bodies.ts — one-time cleanup for gmail_seen_messages rows
 * stored BEFORE mail-source.ts's normalizeMojibake() fix. mailparser
 * substituted U+FFFD for undecodable bytes on some real bank emails (seen on
 * axis.bank.in, hdfcbank.net, icici.bank.in, among others), corrupting the
 * whitespace a parser's regex depends on. The fix stops NEW corruption; this
 * script repairs what's already in the database so those emails can be
 * reparsed (see backfill-missed-txns.ts, run after this).
 *
 * Scoped to txn_id IS NULL rows only — a row that already produced a
 * transaction was parsed successfully despite the corruption, so its stored
 * body is just cosmetically imperfect archival text, not worth touching.
 *
 * READ-ONLY by default. Run:  npx tsx scripts/repair-mojibake-bodies.ts [--apply]
 */
import { readFileSync } from "fs";
import { join } from "path";
for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { createClient } from "@supabase/supabase-js";
import { normalizeMojibake } from "../src/lib/gmail/mail-source";

const APPLY = process.argv.includes("--apply");
const PAGE = 1000;

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: s } = await sb.from("user_settings").select("user_id").limit(1).single();
  const uid = s!.user_id as string;

  type Row = { gmail_message_id: string; raw_subject: string | null; raw_body: string | null };
  const toRepair: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("gmail_seen_messages")
      .select("gmail_message_id, raw_subject, raw_body")
      .eq("user_id", uid)
      .is("txn_id", null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const r of data as Row[]) {
      if ((r.raw_body && r.raw_body.includes("�")) || (r.raw_subject && r.raw_subject.includes("�"))) {
        toRepair.push(r);
      }
    }
    if (data.length < PAGE) break;
  }

  console.log(`${toRepair.length} unmatched row(s) have U+FFFD corruption in raw_subject/raw_body.`);

  if (!APPLY) {
    console.log("DRY RUN — nothing written. Sample:");
    for (const r of toRepair.slice(0, 5)) {
      console.log(`  ${r.gmail_message_id}: "${r.raw_subject}"`);
    }
    console.log("Re-run with --apply to clean these rows, then run backfill-missed-txns.ts.");
    return;
  }

  let repaired = 0;
  for (const r of toRepair) {
    const { error } = await sb
      .from("gmail_seen_messages")
      .update({
        raw_subject: r.raw_subject ? normalizeMojibake(r.raw_subject) : r.raw_subject,
        raw_body: r.raw_body ? normalizeMojibake(r.raw_body) : r.raw_body,
      })
      .eq("user_id", uid)
      .eq("gmail_message_id", r.gmail_message_id);
    if (error) {
      console.error(`  failed ${r.gmail_message_id}: ${error.message}`);
      continue;
    }
    repaired++;
  }
  console.log(`APPLIED — repaired ${repaired}/${toRepair.length} rows.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
