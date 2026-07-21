/**
 * backfill-ikea-pdf.ts — one-time ingest of IKEA order emails that were fetched
 * BEFORE PDF-attachment parsing existed.
 *
 * Those emails were recorded in `gmail_seen_messages` but never stored as
 * `orders` (the old parser returned null: no items in the body). Neither a
 * normal sync (they predate the cursor) nor reparse-orders.ts (it only heals
 * EXISTING order rows) can reach them. They were un-seen on 2026-07-15b; this
 * script does what the sync's fetch-phase would do for exactly those messages.
 *
 * Mirrors src/app/api/gmail/orders/sync/route.ts: body parse first, PDF
 * attachment fallback only when the body yields no items, and EVERY fetched id
 * is re-recorded in gmail_seen_messages regardless of outcome (ARCH-12).
 *
 * MATCHING IS NOT DONE HERE — run a normal Orders sync afterwards; its
 * matching/dedup pass links these rows to card charges (ARCH-04: one matcher).
 *
 * Run:  npx tsx scripts/backfill-ikea-pdf.ts           (dry run)
 *       npx tsx scripts/backfill-ikea-pdf.ts --apply   (write)
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
import { findPdfAttachments, parseOrderFromPdfs, decodeAttachmentData } from "../src/lib/gmail/pdf";
import { parseOrderEmail } from "../src/lib/parsers/orders/registry";

const APPLY = process.argv.includes("--apply");
const PAGE = 1000;

async function main() {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: settings } = await supabase
    .from("user_settings").select("user_id, google_refresh_token_encrypted").limit(1).single();
  const userId = settings!.user_id as string;
  const auth = makeGmailOAuthClient();
  auth.setCredentials({ refresh_token: decrypt(settings!.google_refresh_token_encrypted) });
  const gmail = google.gmail({ version: "v1", auth });

  // EDGE-09: Supabase caps .select() at 1000 rows — paginate explicitly.
  async function loadAllIds(table: string): Promise<Set<string>> {
    const out = new Set<string>();
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase.from(table).select("gmail_message_id")
        .eq("user_id", userId).range(from, from + PAGE - 1);
      if (error) { console.error(`[backfill] ${table} read error — ${error.message}`); break; }
      if (!data?.length) break;
      for (const r of data) if (r.gmail_message_id) out.add(r.gmail_message_id as string);
      if (data.length < PAGE) break;
    }
    return out;
  }
  const [seenIds, orderIds] = await Promise.all([
    loadAllIds("gmail_seen_messages"), loadAllIds("orders"),
  ]);
  const known = new Set<string>([...seenIds, ...orderIds]);

  // Every IKEA message in the mailbox; skip the ones already seen/stored.
  const allIds: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({ userId: "me", q: "from:ikea.com", maxResults: 100, pageToken });
    for (const m of res.data.messages || []) if (m.id) allIds.push(m.id);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  const todo = allIds.filter((id) => !known.has(id));
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — IKEA messages in mailbox: ${allIds.length}; already seen/stored: ${allIds.length - todo.length}; to ingest: ${todo.length}\n`);

  let created = 0, viaPdf = 0, noItems = 0, errors = 0;
  const samples: string[] = [];

  for (let i = 0; i < todo.length; i++) {
    const msgId = todo[i];
    if (i % 10 === 0) process.stderr.write(`  …${i}/${todo.length}\n`);
    let subject = "", from = "", body = "", internalDate = 0;
    try {
      const full = await gmail.users.messages.get({ userId: "me", id: msgId, format: "full" });
      const headers = full.data.payload?.headers || [];
      subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
      from = headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
      internalDate = parseInt(full.data.internalDate ?? "0", 10);
      const text = extractBody(full.data.payload);
      const html = extractHtml(full.data.payload);
      body = text;

      let parsed = parseOrderEmail(from, subject, text, html);
      let usedPdf = false;
      if ((parsed?.items.length ?? 0) === 0) {
        const pdfs = findPdfAttachments(full.data.payload);
        if (pdfs.length > 0) {
          const download = async (attachmentId: string) => {
            const att = await gmail.users.messages.attachments.get({ userId: "me", messageId: msgId, id: attachmentId });
            return decodeAttachmentData(att.data.data);
          };
          const fromPdf = await parseOrderFromPdfs(from, pdfs, download);
          if (fromPdf && fromPdf.items.length > 0) { parsed = fromPdf; usedPdf = true; }
        }
      }

      if (!parsed || parsed.items.length === 0) {
        noItems++;
      } else {
        if (APPLY) {
          const { error } = await supabase.from("orders").upsert({
            user_id: userId,
            source: parsed.source,
            kind: parsed.kind,
            gmail_message_id: msgId,
            order_ref: parsed.order_ref ?? null,
            merchant_name: parsed.merchant_name ?? null,
            total_amount: parsed.total_amount ?? null,
            order_at: new Date(internalDate).toISOString(),
            items: parsed.items,
            raw_subject: subject,
          }, { onConflict: "user_id,gmail_message_id" });
          if (error) { console.error(`[backfill] order upsert ${msgId}: ${error.message}`); errors++; continue; }
        }
        created++;
        if (usedPdf) viaPdf++;
        if (samples.length < 12) {
          samples.push(`${parsed.kind === "refund" ? "REFUND" : "order "} ₹${parsed.total_amount ?? "-"} × ${parsed.items.length} items — ${subject.slice(0, 42)}`);
        }
      }
    } catch (e) {
      errors++;
      console.error(`[backfill] fetch ${msgId}: ${(e as Error).message}`);
    }

    // ARCH-12: record EVERY fetched id — parsed, itemless, or errored.
    if (APPLY) {
      const { error } = await supabase.from("gmail_seen_messages").upsert({
        user_id: userId, gmail_message_id: msgId, txn_id: null,
        raw_subject: subject, raw_body: body, raw_from: from, internal_date: internalDate,
      }, { onConflict: "user_id,gmail_message_id" });
      if (error) console.error(`[backfill] seen upsert ${msgId}: ${error.message}`);
    }
  }

  console.log(`\n── ${APPLY ? "APPLIED" : "DRY RUN"} ──`);
  console.log(`orders created/updated : ${created}  (${viaPdf} via PDF attachment)`);
  console.log(`no items (notifications/T&C) : ${noItems}`);
  console.log(`errors : ${errors}`);
  console.log(`\nSample:\n  ${samples.join("\n  ")}`);
  if (!APPLY) console.log(`\n(dry run — nothing written. Re-run with --apply.)`);
  else console.log(`\nNEXT: run a normal Orders sync in the app — its matching/dedup pass links these to card charges.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
