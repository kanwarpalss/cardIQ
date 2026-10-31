import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { CARD_REGISTRY } from "@/lib/cards/registry";
import { findUnrecognizedFormatCandidates, type SeenRow } from "@/lib/parsers/format-watch";

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
 * GET /api/gmail/format-watch
 *   Header: X-Format-Watch-Secret: <FORMAT_WATCH_SECRET>
 */

const PAGE = 1000;

export async function GET(req: Request) {
  const secret = process.env.FORMAT_WATCH_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "format_watch_not_configured" }, { status: 500 });
  }
  if (req.headers.get("x-format-watch-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const { data: settingsRow, error: settingsErr } = await sb.from("user_settings").select("user_id").limit(1).single();
  if (settingsErr || !settingsRow) {
    return NextResponse.json({ error: "no_user" }, { status: 500 });
  }
  const uid = settingsRow.user_id as string;

  const { data: cards, error: cardsErr } = await sb.from("cards").select("last4").eq("user_id", uid);
  if (cardsErr) {
    return NextResponse.json({ error: `cards: ${cardsErr.message}` }, { status: 500 });
  }
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

  const candidates = findUnrecognizedFormatCandidates(rows, knownLast4s, [...bankDomains]);

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    scanned: rows.length,
    candidate_count: candidates.length,
    candidates: candidates.map((c) => ({
      date: c.internal_date ? new Date(c.internal_date).toISOString().slice(0, 10) : null,
      sender: c.sender,
      subject: c.subject,
      matched_last4: c.matched_last4,
      snippet: c.snippet,
    })),
  });
}
