/**
 * check-unknown-formats.ts — sweep every known bank's already-fetched,
 * not-yet-matched emails (gmail_seen_messages where txn_id IS NULL) for ones
 * mentioning one of the user's own card numbers. See
 * src/lib/parsers/format-watch.ts for why this check is deliberately looser
 * than the parsers/generic-sniffer it watches over (it exists to catch the
 * exact kind of miss those can't see themselves).
 *
 * READ-ONLY — never writes anything. Run: npx tsx scripts/check-unknown-formats.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { createClient } from "@supabase/supabase-js";
import { findUnrecognizedFormatCandidates, type SeenRow } from "../src/lib/parsers/format-watch";
import { CARD_REGISTRY } from "../src/lib/cards/registry";

const PAGE = 1000;

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: s } = await sb.from("user_settings").select("user_id").limit(1).single();
  const uid = s!.user_id as string;

  const { data: cards } = await sb.from("cards").select("last4, nickname, product_key").eq("user_id", uid);
  const knownLast4s = new Set((cards || []).map((c) => c.last4));

  const bankDomains = new Set<string>();
  for (const spec of Object.values(CARD_REGISTRY)) spec.gmail.senders.forEach((d) => bankDomains.add(d));

  const rows: SeenRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("gmail_seen_messages")
      .select("gmail_message_id, raw_from, raw_subject, raw_body, internal_date")
      .eq("user_id", uid)
      .is("txn_id", null)
      .not("raw_body", "is", null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const r of data) {
      rows.push({
        gmail_message_id: r.gmail_message_id,
        raw_from: r.raw_from || "",
        raw_subject: r.raw_subject || "",
        raw_body: r.raw_body || "",
        internal_date: r.internal_date,
      });
    }
    if (data.length < PAGE) break;
  }

  console.log(`Cards on file: ${[...knownLast4s].join(", ")}`);
  console.log(`Bank domains checked: ${[...bankDomains].join(", ")}`);
  console.log(`Unmatched seen-messages scanned: ${rows.length}\n`);

  const candidates = findUnrecognizedFormatCandidates(rows, knownLast4s, [...bankDomains]);

  if (candidates.length === 0) {
    console.log("No candidates — every unmatched email from a known bank either mentions no card we have, or no card at all.");
    return;
  }

  console.log(`${candidates.length} candidate(s) — a known bank's email mentions one of your cards but produced no transaction:\n`);
  for (const c of candidates) {
    const date = c.internal_date ? new Date(c.internal_date).toISOString().slice(0, 10) : "?";
    console.log(`[${date}] ${c.sender} — card ...${c.matched_last4}`);
    console.log(`  Subject: ${c.subject}`);
    console.log(`  ${c.snippet}`);
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
