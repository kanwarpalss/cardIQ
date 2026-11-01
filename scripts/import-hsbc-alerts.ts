/**
 * import-hsbc-alerts.ts — one-off history repair for the HSBC cards.
 *
 * Two sources the normal sync can't reach:
 *   1. The dump: one email whose attachments are the original HSBC emails for
 *      Premier 4502 (the sync doesn't read attachments, and the cursor is past
 *      them). Attachments have no Gmail id, so each row is keyed "eml-<hash of
 *      its Message-ID>", which makes re-running harmless.
 *   2. hsbc.bank.in mail already in this mailbox. HSBC moved its alerts there
 *      around 2026-09, before the sync searched that domain, and the cursor has
 *      since passed those messages.
 *
 * Also creates the Premier 4502 and TravelOne 3337 card rows if they're missing,
 * and links 3337's existing rows to its card.
 *
 * Attachments that aren't transactions (OTP, limit, credit notices) are counted
 * and dropped, never stored. A dump row whose card, date, currency and amount
 * match an existing transaction is reported and skipped, so a forwarded copy of
 * the same alert can't double-count.
 *
 * READ-ONLY by default. Run:  npx tsx scripts/import-hsbc-alerts.ts [--apply]
 */
import { createHash } from "crypto";
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { parseTxnEmailWithFallback } from "../src/lib/parsers/registry";
import { categorizeFull } from "../src/lib/categorize";
import { cleanMerchant } from "../src/lib/merchant-clean";
import { enrichAmount } from "../src/lib/txn-enrich";
import { decrypt } from "../src/lib/crypto";
import { ImapSource, normalizeMojibake, redactOtp } from "../src/lib/gmail/mail-source";
import { stripHtml } from "../src/lib/gmail/strip";

const APPLY = process.argv.includes("--apply");
const CARD_ROWS = [
  { last4: "4502", product_key: "hsbc_premier", nickname: "HSBC Premier" },
  { last4: "3337", product_key: "hsbc_travelone", nickname: "HSBC TravelOne" },
];
const DUMP_QUERY = 'from:birsimrat1@gmail.com subject:"hsbc emails" has:attachment';
const EXPECTED_DUMP_ATTACHMENTS = 50;

type Mail = { id: string; from: string; subject: string; dateHeader: string | null; body: string; internalDate: number };

function istDay(d: Date): string {
  return new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

async function readDump(user: string, pass: string): Promise<Mail[]> {
  const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user, pass }, logger: false });
  await client.connect();
  const lock = await client.getMailboxLock("[Gmail]/All Mail");
  try {
    const uids = await client.search({ gmailraw: DUMP_QUERY }, { uid: true });
    if (!uids || uids.length !== 1) throw new Error(`Expected exactly one dump email, found ${uids ? uids.length : 0}`);
    const raw = await client.fetchOne(uids[0], { uid: true, source: true }, { uid: true });
    if (!raw || !raw.source) throw new Error("Dump email has no source");
    const parent = await simpleParser(raw.source);
    const emls = parent.attachments.filter((a) => a.contentType === "message/rfc822" || /\.eml$/i.test(a.filename || ""));
    if (emls.length !== EXPECTED_DUMP_ATTACHMENTS) {
      throw new Error(`Expected ${EXPECTED_DUMP_ATTACHMENTS} attachments in the dump, read ${emls.length}`);
    }
    const out: Mail[] = [];
    for (const att of emls) {
      const m = await simpleParser(att.content);
      if (!m.messageId) throw new Error(`Attachment "${att.filename}" has no Message-ID`);
      const text = m.text ?? (typeof m.html === "string" ? stripHtml(m.html) : "");
      out.push({
        id: `eml-${createHash("sha256").update(m.messageId).digest("hex").slice(0, 24)}`,
        from: m.from?.text || "",
        subject: m.subject || "",
        dateHeader: m.date ? m.date.toUTCString() : null,
        body: redactOtp(normalizeMojibake(text)),
        internalDate: m.date ? m.date.getTime() : 0,
      });
    }
    return out;
  } finally {
    lock.release();
    await client.logout();
  }
}

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: s, error: sErr } = await sb
    .from("user_settings")
    .select("user_id, gmail_user, gmail_app_password_encrypted")
    .not("gmail_app_password_encrypted", "is", null)
    .limit(1)
    .single();
  if (sErr || !s) throw new Error(`No mailbox credentials: ${sErr?.message}`);
  const uid = s.user_id as string;
  const imapUser = s.gmail_user as string;
  const imapPass = decrypt(s.gmail_app_password_encrypted as string);

  const [cardsRes, mappingsRes] = await Promise.all([
    sb.from("cards").select("id, last4").eq("user_id", uid),
    sb.from("merchant_mappings").select("raw_name, normalized_name, category, subcategory").eq("user_id", uid),
  ]);
  if (cardsRes.error) throw new Error(cardsRes.error.message);
  if (mappingsRes.error) throw new Error(mappingsRes.error.message);

  const cardByLast4 = new Map((cardsRes.data || []).map((c) => [c.last4 as string, c.id as string]));
  const merchantMap = new Map((mappingsRes.data || []).map((m) => [(m.raw_name as string).toLowerCase(), m]));

  for (const c of CARD_ROWS) {
    if (cardByLast4.has(c.last4)) {
      console.log(`Card ${c.last4}: already exists`);
    } else {
      console.log(`Card ${c.last4}: ${APPLY ? "creating" : "would create"} ${c.nickname}`);
      if (APPLY) {
        const { data: card, error } = await sb
          .from("cards")
          .insert({ user_id: uid, ...c })
          .select("id")
          .single();
        if (error || !card) throw new Error(`Card insert failed: ${error?.message}`);
        cardByLast4.set(c.last4, card.id as string);
      }
    }
    const cardId = cardByLast4.get(c.last4);
    const orphans = await sb.from("transactions").select("id", { count: "exact", head: true })
      .eq("user_id", uid).eq("card_last4", c.last4).is("card_id", null);
    if (orphans.error) throw new Error(orphans.error.message);
    if (orphans.count) {
      console.log(`Card ${c.last4}: ${APPLY ? "linking" : "would link"} ${orphans.count} existing row(s)`);
      if (APPLY && cardId) {
        const { error } = await sb.from("transactions").update({ card_id: cardId })
          .eq("user_id", uid).eq("card_last4", c.last4).is("card_id", null);
        if (error) throw new Error(`Link failed: ${error.message}`);
      }
    }
  }
  const knownLast4s = new Set([...cardByLast4.keys(), ...CARD_ROWS.map((c) => c.last4)]);

  async function handleMail(mail: Mail, fromDump: boolean): Promise<"txn" | "dup" | "skipped"> {
    const parsed = parseTxnEmailWithFallback(mail.from, mail.subject, mail.body, "", knownLast4s);
    const seenRow = {
      user_id: uid,
      gmail_message_id: mail.id,
      raw_subject: mail.subject,
      raw_body: mail.body,
      raw_from: mail.from,
      internal_date: mail.internalDate,
    };

    if (!parsed) {
      // Mailbox messages are recorded like the sync records them. Non-transaction
      // attachments have no Gmail id and no later use, so they're dropped.
      if (APPLY && !fromDump) {
        const { error } = await sb.from("gmail_seen_messages")
          .upsert({ ...seenRow, txn_id: null }, { onConflict: "user_id,gmail_message_id" });
        if (error) throw new Error(`seen write failed for ${mail.id}: ${error.message}`);
      }
      return "skipped";
    }

    const txnAt = mail.dateHeader ? new Date(mail.dateHeader) : parsed.txn_at;
    if (istDay(txnAt) !== istDay(parsed.txn_at)) {
      console.log(`  NOTE ${mail.id}: email is dated ${istDay(txnAt)}, its text says ${istDay(parsed.txn_at)}. Using the email date, as the sync does.`);
    }

    const rawKey = parsed.merchant_raw?.toLowerCase() ?? "";
    const cleaned = cleanMerchant(parsed.merchant_raw);
    const cleanedKey = cleaned?.toLowerCase() ?? "";
    const mapping = (rawKey ? merchantMap.get(rawKey) : undefined) ?? (cleanedKey ? merchantMap.get(cleanedKey) : undefined);
    const merchant = (mapping?.normalized_name as string | undefined) ?? cleaned ?? null;
    const ruled = categorizeFull(merchant);
    const category = (mapping?.category as string | undefined) ?? ruled.category;
    const subcategory = mapping ? ((mapping.subcategory as string | null) ?? null) : ruled.subcategory;

    const money = parsed.currency ? `${parsed.currency} ${parsed.amount_original}` : `INR ${parsed.amount_inr}`;
    const line = `${istDay(txnAt)}  ...${parsed.card_last4}  ${parsed.txn_type.padEnd(6)}  ${money.padEnd(14)}  ${merchant ?? "(no merchant)"}  [${category}]${parsed.low_confidence ? "  LOW-CONFIDENCE" : ""}`;

    if (fromDump) {
      // Same purchase already stored under another id: a forwarded copy.
      const dayStart = new Date(`${istDay(txnAt)}T00:00:00+05:30`);
      const dayEnd = new Date(dayStart.getTime() + 86400 * 1000);
      const { data: existing, error } = await sb
        .from("transactions")
        .select("gmail_message_id, amount_inr, original_currency, original_amount")
        .eq("user_id", uid)
        .eq("card_last4", parsed.card_last4)
        .eq("txn_type", parsed.txn_type)
        .gte("txn_at", dayStart.toISOString())
        .lt("txn_at", dayEnd.toISOString());
      if (error) throw new Error(error.message);
      const code = parsed.currency ?? "INR";
      const amount = parsed.amount_original ?? parsed.amount_inr;
      const twin = (existing || []).find((r) =>
        r.gmail_message_id !== mail.id &&
        (r.original_currency ?? "INR") === code &&
        Number(r.original_amount ?? r.amount_inr) === amount);
      if (twin) {
        console.log(`  DUP   ${line}  (already stored as ${twin.gmail_message_id})`);
        return "dup";
      }
    }

    console.log(`  ${APPLY ? "WROTE" : "WOULD"} ${line}`);
    if (!APPLY) return "txn";

    const enriched = await enrichAmount(sb, parsed, txnAt);
    const { data: row, error: upsertErr } = await sb
      .from("transactions")
      .upsert(
        {
          user_id: uid,
          card_id: cardByLast4.get(parsed.card_last4) ?? null,
          card_last4: parsed.card_last4,
          amount_inr: enriched.amount_inr,
          original_currency: enriched.original_currency,
          original_amount: enriched.original_amount,
          low_confidence: parsed.low_confidence ?? false,
          merchant,
          category,
          subcategory,
          txn_type: parsed.txn_type,
          txn_at: txnAt.toISOString(),
          gmail_message_id: mail.id,
          raw_subject: mail.subject,
          raw_body: mail.body,
        },
        { onConflict: "user_id,gmail_message_id" },
      )
      .select("id")
      .single();
    if (upsertErr || !row) throw new Error(`txn write failed for ${mail.id}: ${upsertErr?.message}`);

    const { error: seenErr } = await sb.from("gmail_seen_messages")
      .upsert({ ...seenRow, txn_id: row.id }, { onConflict: "user_id,gmail_message_id" });
    if (seenErr) throw new Error(`seen write failed for ${mail.id}: ${seenErr.message}`);
    return "txn";
  }

  function tally(results: Array<{ mail: Mail; outcome: string }>) {
    const counts: Record<string, number> = {};
    for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
    const skipped: Record<string, number> = {};
    for (const r of results) if (r.outcome === "skipped") skipped[r.mail.subject] = (skipped[r.mail.subject] ?? 0) + 1;
    return { counts, skipped };
  }

  // ── Source 1: the dump ──────────────────────────────────────────────────
  console.log("\nDump attachments:");
  const dump = await readDump(imapUser, imapPass);
  const dumpResults = [];
  for (const mail of dump) dumpResults.push({ mail, outcome: await handleMail(mail, true) });
  console.log(tally(dumpResults));

  // ── Source 2: hsbc.bank.in mail the sync never searched ─────────────────
  console.log("\nhsbc.bank.in mail not yet seen:");
  const source = new ImapSource(imapUser, imapPass);
  try {
    const ids = await source.search("from:hsbc.bank.in");
    const seen = new Set<string>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("gmail_seen_messages").select("gmail_message_id").eq("user_id", uid).range(from, from + 999);
      if (error) throw new Error(error.message);
      for (const r of data || []) seen.add(r.gmail_message_id as string);
      if (!data || data.length < 1000) break;
    }
    const fresh = ids.filter((id) => !seen.has(id));
    console.log(`  ${ids.length} found, ${fresh.length} not yet seen`);
    const results = [];
    for (const id of fresh) {
      const m = await source.fetchMessage(id);
      const mail: Mail = { id, from: m.from, subject: m.subject, dateHeader: m.dateHeader, body: m.textBody, internalDate: m.internalDate };
      results.push({ mail, outcome: await handleMail(mail, false) });
    }
    console.log(tally(results));
  } finally {
    await source.close();
  }

  console.log(APPLY ? "\nAPPLIED." : "\nDRY RUN — nothing written. Re-run with --apply to write.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
