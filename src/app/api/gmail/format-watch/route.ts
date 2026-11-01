import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { BANK_EMAIL_SENDERS } from "@/lib/cards/registry";
import {
  findQuietCards,
  findUnrecognizedFormatCandidates,
  QUIET_LOOKBACK_DAYS,
  type QuietCardTxn,
  type SeenRow,
} from "@/lib/parsers/format-watch";
import { MAILBOX_WINDOW_DAYS, runMailboxWatch } from "@/lib/gmail/mailbox-watch";
import { pickMailSource } from "@/lib/gmail/mail-source";
import { decrypt } from "@/lib/crypto";

/**
 * Read-only, no-session diagnostic: are any known bank's emails mentioning
 * one of the user's own card numbers without producing a transaction? Built
 * to catch the NEXT silent template change the way the 2026-10 Axis
 * "generic alert" bug was caught — see format-watch.ts's header for why this
 * check is deliberately looser than the parsers it watches over.
 *
 * Called by a weekly cloud routine, not a logged-in browser — there is no
 * Supabase auth cookie to check, so this is gated by a shared secret instead
 * (FORMAT_WATCH_SECRET, set in Vercel's env vars) and uses the service-role
 * key directly rather than the per-request RLS client every other route
 * uses. Single-user app: there is exactly one row in user_settings.
 *
 * Reads Gmail (read-only) as well as the database, because mail from a sender
 * the sync doesn't search never reaches the database at all. Each candidate has
 * a `kind`:
 *   unparsed        fetched from a known bank, but no transaction came of it
 *   unlisted_sender mentions a card, from a sender the sync never searches
 *   quiet_card      a regularly used card has stopped showing charges
 *   no_card         a stored transaction has no card number, so no tab shows it
 *   check_failed    part of this check couldn't run, so silence proves nothing
 *
 * GET /api/gmail/format-watch
 *   Header: X-Format-Watch-Secret: <FORMAT_WATCH_SECRET>
 */

export const maxDuration = 60;

const PAGE = 1000;

type Candidate = {
  kind: "unparsed" | "unlisted_sender" | "quiet_card" | "no_card" | "check_failed";
  date: string | null;
  sender: string;
  subject: string;
  matched_last4: string;
  snippet: string;
};

function dateOf(internalDate: number | null | undefined): string | null {
  return internalDate ? new Date(internalDate).toISOString().slice(0, 10) : null;
}

export async function GET(req: Request) {
  const secret = process.env.FORMAT_WATCH_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "format_watch_not_configured" }, { status: 500 });
  }
  if (req.headers.get("x-format-watch-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const { data: settingsRow, error: settingsErr } = await sb
    .from("user_settings")
    .select("user_id, gmail_user, gmail_app_password_encrypted, google_refresh_token_encrypted, last_gmail_sync_at")
    .limit(1)
    .single();
  if (settingsErr || !settingsRow) {
    return NextResponse.json({ error: "no_user" }, { status: 500 });
  }
  const uid = settingsRow.user_id as string;

  const { data: cards, error: cardsErr } = await sb.from("cards").select("last4").eq("user_id", uid);
  if (cardsErr) {
    return NextResponse.json({ error: `cards: ${cardsErr.message}` }, { status: 500 });
  }
  const knownLast4s = new Set((cards || []).map((c) => c.last4));

  const bankDomains = new Set(BANK_EMAIL_SENDERS);

  const rows: SeenRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("gmail_seen_messages")
      .select("gmail_message_id, raw_from, raw_subject, raw_body, internal_date")
      .eq("user_id", uid)
      .is("txn_id", null)
      .not("raw_body", "is", null)
      .range(from, from + PAGE - 1);
    if (error) {
      return NextResponse.json({ error: `gmail_seen_messages: ${error.message}` }, { status: 500 });
    }
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

  const candidates: Candidate[] = findUnrecognizedFormatCandidates(rows, knownLast4s, [...bankDomains]).map((c) => ({
    kind: "unparsed" as const,
    date: dateOf(c.internal_date),
    sender: c.sender,
    subject: c.subject,
    matched_last4: c.matched_last4,
    snippet: c.snippet,
  }));
  const checkFailed = (snippet: string) =>
    candidates.push({ kind: "check_failed", date: null, sender: "format-watch", subject: "Part of this check could not run", matched_last4: "", snippet });

  // ── Mail the sync never fetches ───────────────────────────────────────────
  let mailboxChecked = 0;
  try {
    const source = pickMailSource({
      imapUser: settingsRow.gmail_user,
      imapPass: settingsRow.gmail_app_password_encrypted ? decrypt(settingsRow.gmail_app_password_encrypted) : undefined,
      oauthRefreshToken: settingsRow.google_refresh_token_encrypted ? decrypt(settingsRow.google_refresh_token_encrypted) : undefined,
    });
    const mailbox = await runMailboxWatch(source, knownLast4s, [...bankDomains]);
    mailboxChecked = mailbox.checked;
    if (mailbox.error) checkFailed(mailbox.error);
    for (const c of mailbox.candidates) {
      candidates.push({ kind: "unlisted_sender", date: dateOf(c.internal_date), sender: c.sender, subject: c.subject, matched_last4: c.matched_last4, snippet: c.snippet });
    }
  } catch (e) {
    checkFailed(`mailbox check failed: ${(e as Error).message}`);
  }

  // ── Cards that went quiet ─────────────────────────────────────────────────
  const quietTxns: QuietCardTxn[] = [];
  const since = new Date(Date.now() - QUIET_LOOKBACK_DAYS * 86400 * 1000).toISOString();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("transactions")
      .select("card_last4, txn_type, txn_at")
      .eq("user_id", uid)
      .gte("txn_at", since)
      .range(from, from + PAGE - 1);
    if (error) {
      checkFailed(`quiet-card check failed: ${error.message}`);
      break;
    }
    quietTxns.push(...((data ?? []) as QuietCardTxn[]));
    if (!data || data.length < PAGE) break;
  }
  for (const q of findQuietCards(quietTxns, [...knownLast4s], new Date())) {
    candidates.push({
      kind: "quiet_card",
      date: q.lastChargeAt.slice(0, 10),
      sender: "transactions",
      subject: `No charges on card ${q.last4} for ${q.daysQuiet} days`,
      matched_last4: q.last4,
      snippet: `Longest earlier gap was ${q.longestGapDays} days. Last sync: ${settingsRow.last_gmail_sync_at ?? "never"}.`,
    });
  }

  // ── Transactions no tab can show under a card ─────────────────────────────
  const { data: noCard, error: noCardErr } = await sb
    .from("transactions")
    .select("txn_at, amount_inr, merchant, raw_subject")
    .eq("user_id", uid)
    .or("card_last4.is.null,card_last4.eq.");
  if (noCardErr) checkFailed(`no-card check failed: ${noCardErr.message}`);
  for (const r of noCard ?? []) {
    candidates.push({
      kind: "no_card",
      date: String(r.txn_at).slice(0, 10),
      sender: "transactions",
      subject: r.raw_subject ?? "",
      matched_last4: "",
      snippet: `₹${r.amount_inr} at ${r.merchant ?? "unknown merchant"}`,
    });
  }

  const counts: Record<string, number> = {};
  for (const c of candidates) counts[c.kind] = (counts[c.kind] ?? 0) + 1;

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    scanned: rows.length,
    mailbox_checked: mailboxChecked,
    mailbox_window_days: MAILBOX_WINDOW_DAYS,
    last_sync: settingsRow.last_gmail_sync_at ?? null,
    candidate_count: candidates.length,
    counts,
    candidates,
  });
}
