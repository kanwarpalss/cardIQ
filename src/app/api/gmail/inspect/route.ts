import { google } from "googleapis";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/crypto";
import { parseTxnEmail } from "@/lib/parsers/registry";

/**
 * Inspect a single Gmail message — full headers, full body, and the result
 * of running it through every parser. Designed for diagnosing parse failures.
 *
 * Usage:
 *   GET /api/gmail/inspect?id=<gmail_message_id>
 *   GET /api/gmail/inspect?q=<gmail_search_query>&n=5     // first N matches
 *
 * The `q` form is super handy for "find me the 3 most recent HDFC Infinia
 * emails in March 2026 that didn't parse" without leaving the terminal:
 *
 *   /api/gmail/inspect?q=from:hdfcbank.net+after:2026/03/01+before:2026/04/01&n=10
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

function extractBody(payload: any): { plain: string; html_stripped: string } {
  let plain = "";
  let html  = "";
  function walk(p: any) {
    if (!p) return;
    if (p.mimeType === "text/plain" && p.body?.data) plain ||= base64Decode(p.body.data);
    else if (p.mimeType === "text/html"  && p.body?.data) html  ||= base64Decode(p.body.data);
    else if (p.body?.data) {
      const decoded = base64Decode(p.body.data);
      if (decoded.includes("<")) html ||= decoded;
      else plain ||= decoded;
    }
    if (p.parts) for (const part of p.parts) walk(part);
  }
  walk(payload);
  return { plain, html_stripped: html ? stripHtml(html) : "" };
}

export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const msgId = url.searchParams.get("id");
  const query = url.searchParams.get("q");
  const n     = Math.min(parseInt(url.searchParams.get("n") || "5", 10), 25);

  if (!msgId && !query) {
    return NextResponse.json({ error: "missing 'id' or 'q' parameter" }, { status: 400 });
  }

  const { data: settings } = await supabase
    .from("user_settings")
    .select("google_refresh_token_encrypted")
    .eq("user_id", user.id)
    .single();

  if (!settings?.google_refresh_token_encrypted) {
    return NextResponse.json({ error: "no_refresh_token" }, { status: 400 });
  }

  const auth = getOAuthClient();
  auth.setCredentials({ refresh_token: decrypt(settings.google_refresh_token_encrypted) });
  const gmail = google.gmail({ version: "v1", auth });

  const idsToFetch: string[] = [];
  if (msgId) {
    idsToFetch.push(msgId);
  } else {
    const list = await gmail.users.messages.list({ userId: "me", q: query!, maxResults: n });
    for (const m of list.data.messages || []) if (m.id) idsToFetch.push(m.id);
  }

  const results = await Promise.all(idsToFetch.map(async (id) => {
    try {
      const full = await gmail.users.messages.get({ userId: "me", id, format: "full" });
      const headers = full.data.payload?.headers || [];
      const get = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;

      const subject = get("Subject") || "";
      const from    = get("From") || "";
      const date    = get("Date");
      const { plain, html_stripped } = extractBody(full.data.payload);
      const snippet = full.data.snippet || "";
      const body    = plain || html_stripped;

      const parsed = parseTxnEmail(from, subject, body, snippet);

      return {
        id,
        internal_date_iso: full.data.internalDate
          ? new Date(parseInt(full.data.internalDate, 10)).toISOString()
          : null,
        from,
        subject,
        date_header: date,
        snippet,
        body_plain_present: !!plain,
        body_html_stripped_present: !!html_stripped,
        body_used: body,
        body_length: body.length,
        parsed,
        parse_failed: !parsed,
      };
    } catch (e) {
      return { id, error: (e as Error).message };
    }
  }));

  return NextResponse.json({ count: results.length, results });
}
