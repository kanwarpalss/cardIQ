import { google } from "googleapis";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/crypto";
import { CARD_REGISTRY } from "@/lib/cards/registry";
import { parseTxnEmail } from "@/lib/parsers/registry";

/**
 * Read-only diagnostic endpoint. Does NOT write anything.
 *
 * Returns a full sync health report:
 *   • Cursor state (last_internal_date as date, message_count, last_synced_at)
 *   • Transactions count per card_last4 + per month
 *   • gmail_seen_messages total
 *   • Exact Gmail query that the sync route would build
 *   • Result of running that query for the last 365 days (count only)
 *   • Top 20 unique 'from:' addresses appearing in those results
 *   • For 10 most recent results: from / subject / parses-as-txn
 *
 * Use this to figure out:
 *   "Why did Gmail only return 1 email when I asked for 5 years?"
 *   "Why are HDFC March/Apr/May transactions missing?"
 */

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
}

function base64Decode(str: string): string {
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function extractBody(payload: any): string {
  if (!payload) return "";
  if (payload.body?.data) {
    const decoded = base64Decode(payload.body.data);
    return decoded.includes("<") ? stripHtml(decoded) : decoded;
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) return base64Decode(part.body.data);
    }
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) return stripHtml(base64Decode(part.body.data));
    }
  }
  return "";
}

export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const days = parseInt(url.searchParams.get("days") || "365", 10);

  // ── 1. Pull DB state ──────────────────────────────────────────────────────
  const [settingsRes, cursorRes, txnRes, seenRes, cardsRes] = await Promise.all([
    supabase.from("user_settings").select("google_refresh_token_encrypted, last_gmail_sync_at").eq("user_id", user.id).single(),
    supabase.from("gmail_sync_state").select("*").eq("user_id", user.id).eq("sender", "_all").maybeSingle(),
    supabase.from("transactions").select("card_last4, txn_at").eq("user_id", user.id),
    supabase.from("gmail_seen_messages").select("gmail_message_id", { count: "exact", head: true }).eq("user_id", user.id),
    supabase.from("cards").select("last4, product_key, nickname").eq("user_id", user.id),
  ]);

  if (!settingsRes.data?.google_refresh_token_encrypted) {
    return NextResponse.json({ error: "no_refresh_token" }, { status: 400 });
  }

  // ── 2. Aggregate transactions by card and by month ────────────────────────
  const txnsByCard: Record<string, number> = {};
  const txnsByMonth: Record<string, Record<string, number>> = {};
  for (const t of txnRes.data || []) {
    txnsByCard[t.card_last4] = (txnsByCard[t.card_last4] || 0) + 1;
    const mo = t.txn_at.slice(0, 7);
    if (!txnsByMonth[t.card_last4]) txnsByMonth[t.card_last4] = {};
    txnsByMonth[t.card_last4][mo] = (txnsByMonth[t.card_last4][mo] || 0) + 1;
  }

  // ── 3. Build the same Gmail query the sync route would build ──────────────
  const allSenders = new Set<string>();
  for (const spec of Object.values(CARD_REGISTRY)) {
    spec.gmail.senders.forEach((s) => allSenders.add(s));
  }
  const fromClause = [...allSenders].map((s) => `from:${s}`).join(" OR ");
  const afterSeconds = Math.floor((Date.now() - days * 86400 * 1000) / 1000);
  const query = `(${fromClause}) after:${afterSeconds}`;

  // ── 4. Run the Gmail query (LIST only, super lightweight) ─────────────────
  const auth = getOAuthClient();
  auth.setCredentials({ refresh_token: decrypt(settingsRes.data.google_refresh_token_encrypted) });
  const gmail = google.gmail({ version: "v1", auth });

  let gmailError: string | null = null;
  let allIds: string[] = [];
  let gmailProfile: { emailAddress?: string | null; messagesTotal?: number | null } = {};

  try {
    // Which Gmail account is this? Critical sanity check.
    const profile = await gmail.users.getProfile({ userId: "me" });
    gmailProfile = {
      emailAddress: profile.data.emailAddress,
      messagesTotal: profile.data.messagesTotal,
    };

    let pageToken: string | undefined;
    do {
      const r = await gmail.users.messages.list({ userId: "me", q: query, maxResults: 500, pageToken });
      for (const m of r.data.messages || []) if (m.id) allIds.push(m.id);
      pageToken = r.data.nextPageToken ?? undefined;
      if (allIds.length > 2000) break;     // safety cap
    } while (pageToken);
  } catch (e) {
    gmailError = (e as Error).message;
  }

  // ── 5. Inspect the top 10 most recent matches: from / subject / parseable? ─
  const samples: Array<{
    id: string;
    from: string;
    subject: string;
    date: string | null;
    parsed_as_txn: boolean;
    parsed_card_last4?: string;
    parsed_amount?: number;
    parsed_merchant?: string | null;
    already_in_seen: boolean;
    already_in_txns: boolean;
  }> = [];

  // Build sets of known IDs
  const txnIds = new Set<string>();
  {
    const { data } = await supabase.from("transactions").select("gmail_message_id").eq("user_id", user.id);
    for (const r of data || []) if (r.gmail_message_id) txnIds.add(r.gmail_message_id);
  }
  const seenIds = new Set<string>();
  {
    const { data } = await supabase.from("gmail_seen_messages").select("gmail_message_id").eq("user_id", user.id);
    for (const r of data || []) seenIds.add(r.gmail_message_id);
  }

  const fromCounts: Record<string, number> = {};

  for (const id of allIds.slice(0, 10)) {
    try {
      const full = await gmail.users.messages.get({ userId: "me", id, format: "full" });
      const headers = full.data.payload?.headers || [];
      const from    = headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
      const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
      const date    = headers.find((h) => h.name?.toLowerCase() === "date")?.value || null;
      const body    = extractBody(full.data.payload);
      const parsed  = parseTxnEmail(from, subject, body, full.data.snippet || "");

      const fromAddr = (from.match(/<([^>]+)>/)?.[1] || from).toLowerCase().trim();
      fromCounts[fromAddr] = (fromCounts[fromAddr] || 0) + 1;

      samples.push({
        id, from, subject, date,
        parsed_as_txn: !!parsed,
        parsed_card_last4: parsed?.card_last4,
        parsed_amount: parsed?.amount_inr,
        parsed_merchant: parsed?.merchant_raw,
        already_in_seen: seenIds.has(id),
        already_in_txns: txnIds.has(id),
      });
    } catch (e) {
      samples.push({
        id, from: "ERROR", subject: (e as Error).message, date: null,
        parsed_as_txn: false, already_in_seen: seenIds.has(id), already_in_txns: txnIds.has(id),
      });
    }
  }

  // ── 6. Return the full report ─────────────────────────────────────────────
  return NextResponse.json({
    gmail_account: gmailProfile,
    cursor: cursorRes.data
      ? {
          last_internal_date_iso: cursorRes.data.last_internal_date
            ? new Date(cursorRes.data.last_internal_date).toISOString()
            : null,
          last_synced_at: cursorRes.data.last_synced_at,
          message_count: cursorRes.data.message_count,
        }
      : null,
    db_state: {
      total_transactions: txnRes.data?.length ?? 0,
      total_seen_messages: seenRes.count ?? 0,
      transactions_by_card: txnsByCard,
      transactions_by_card_by_month: txnsByMonth,
      cards_configured: cardsRes.data,
    },
    gmail_query: {
      query,
      lookback_days: days,
      after_iso: new Date(afterSeconds * 1000).toISOString(),
      total_matches: allIds.length,
      capped_at_2000: allIds.length >= 2000,
      already_in_seen_count: allIds.filter((id) => seenIds.has(id)).length,
      already_in_txns_count: allIds.filter((id) => txnIds.has(id)).length,
      truly_new_count: allIds.filter((id) => !seenIds.has(id) && !txnIds.has(id)).length,
      gmail_error: gmailError,
    },
    sample_messages: samples,
    senders_configured: [...allSenders],
  });
}
