import { google } from "googleapis";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/crypto";
import { CARD_REGISTRY } from "@/lib/cards/registry";

/**
 * Discovery sweep: finds Gmail senders that LOOK like bank/transaction
 * notifications but aren't in any card spec's sender list. Helps the user
 * spot:
 *
 *   • New banks they got cards from (e.g. signed up for a Yes Bank card,
 *     transactions are coming in but we never queried for them)
 *   • Banks that changed their alerting domain (the HDFC hdfcbank.bank.in
 *     migration would have shown up here)
 *
 * Strategy: query Gmail for transactional-shaped subjects in the last
 * `days` window, then bucket by sender domain. Subtract domains we already
 * cover. Return the rest, sorted by frequency.
 *
 * GET /api/gmail/discover?days=180
 */

const TXN_SUBJECT_QUERY = [
  "subject:(debited OR credited OR spent OR transaction OR purchase OR refund)",
  '("credit card" OR "credit-card" OR "debit card" OR "your card")',
].join(" ");

export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url  = new URL(req.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "180", 10), 30), 730);

  const { data: settings } = await supabase
    .from("user_settings")
    .select("google_refresh_token_encrypted")
    .eq("user_id", user.id)
    .single();

  if (!settings?.google_refresh_token_encrypted) {
    return NextResponse.json({ error: "no_refresh_token" }, { status: 400 });
  }

  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: decrypt(settings.google_refresh_token_encrypted) });
  const gmail = google.gmail({ version: "v1", auth });

  // Build the set of senders we already know about, so we can subtract them
  // from the discovery results. This keeps the output focused on truly NEW
  // senders rather than re-listing the ones we already handle.
  const knownSenders = new Set<string>();
  for (const spec of Object.values(CARD_REGISTRY)) {
    spec.gmail.senders.forEach((s) => knownSenders.add(s.toLowerCase()));
  }

  const afterSecs = Math.floor((Date.now() - days * 86400000) / 1000);
  const query = `${TXN_SUBJECT_QUERY} after:${afterSecs}`;

  // Sample up to ~500 messages — enough to reveal sender patterns without
  // burning Gmail API quota.
  const messageIds: string[] = [];
  let pageToken: string | undefined;
  do {
    const r = await gmail.users.messages.list({ userId: "me", q: query, maxResults: 100, pageToken });
    for (const m of r.data.messages || []) if (m.id) messageIds.push(m.id);
    pageToken = r.data.nextPageToken ?? undefined;
    if (messageIds.length >= 500) break;
  } while (pageToken);

  // Fetch headers only — we just need From: + Subject:.
  const senderCounts = new Map<string, { count: number; sample_subjects: Set<string> }>();

  for (const id of messageIds) {
    try {
      const msg = await gmail.users.messages.get({
        userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject"],
      });
      const headers = msg.data.payload?.headers || [];
      const from = headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
      const subj = headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";

      // Extract domain. From header is "Display Name <addr@domain.com>" or "addr@domain.com".
      const m = /@([\w.-]+)/.exec(from);
      if (!m) continue;
      const domain = m[1].toLowerCase();

      // Skip if any known sender substring is contained in (or contains) this domain.
      const isKnown = [...knownSenders].some((s) => domain.includes(s) || s.includes(domain));
      if (isKnown) continue;

      // Filter out obvious non-bank domains to keep noise down.
      if (/(gmail|yahoo|outlook|hotmail|icloud|proton|googlemail)\./.test(domain)) continue;

      const entry = senderCounts.get(domain) ?? { count: 0, sample_subjects: new Set<string>() };
      entry.count++;
      if (entry.sample_subjects.size < 3) entry.sample_subjects.add(subj);
      senderCounts.set(domain, entry);
    } catch {
      // skip individual fetch errors — one bad message shouldn't kill the sweep
    }
  }

  const candidates = [...senderCounts.entries()]
    .map(([domain, v]) => ({
      domain,
      count: v.count,
      sample_subjects: [...v.sample_subjects],
    }))
    .filter((c) => c.count >= 2)              // ignore one-offs
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);

  return NextResponse.json({
    sampled_messages: messageIds.length,
    days_back: days,
    known_senders: [...knownSenders],
    candidate_unknown_senders: candidates,
    next_step: candidates.length > 0
      ? "If any of these look like a bank you have a card with, add the domain to that card's gmail.senders array in src/lib/cards/."
      : "No new senders detected. You're fully covered.",
  });
}
