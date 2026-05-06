import { google } from "googleapis";
import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/crypto";
import { parseTxnEmail } from "@/lib/parsers/registry";
import { categorize } from "@/lib/categorize";
import { cleanMerchant } from "@/lib/merchant-clean";
import { CARD_REGISTRY } from "@/lib/cards/registry";

const LOOKBACK_DAYS = 365;

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
}

function send(controller: ReadableStreamDefaultController, data: object) {
  controller.enqueue(new TextEncoder().encode(JSON.stringify(data) + "\n"));
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
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&rdquo;|&ldquo;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function extractBody(payload: any): string {
  if (!payload) return "";

  // Prefer text/plain
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return base64Decode(payload.body.data);
  }
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return stripHtml(base64Decode(payload.body.data));
  }
  if (payload.body?.data) {
    const decoded = base64Decode(payload.body.data);
    return decoded.includes("<") ? stripHtml(decoded) : decoded;
  }

  if (payload.parts) {
    // Prefer plain text first
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return base64Decode(part.body.data);
      }
    }
    // Then HTML (stripped)
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        return stripHtml(base64Decode(part.body.data));
      }
    }
    // Recurse into nested parts (multipart/alternative, multipart/related, etc.)
    for (const part of payload.parts) {
      const body = extractBody(part);
      if (body) return body;
    }
  }
  return "";
}

export async function POST() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });

  const { data: settings } = await supabase
    .from("user_settings")
    .select("google_refresh_token_encrypted")
    .eq("user_id", user.id)
    .single();

  if (!settings?.google_refresh_token_encrypted) {
    return new Response(
      JSON.stringify({ error: "no_refresh_token", message: "Sign out and sign in again to re-grant Gmail access." }),
      { status: 400 }
    );
  }

  const { data: cards } = await supabase
    .from("cards")
    .select("id, last4")
    .eq("user_id", user.id);

  const cardByLast4 = new Map((cards || []).map((c) => [c.last4, c.id]));

  // Load merchant mappings for instant normalization during sync
  const { data: mappingsRaw } = await supabase
    .from("merchant_mappings")
    .select("raw_name, normalized_name, category")
    .eq("user_id", user.id);

  const merchantMap = new Map(
    (mappingsRaw || []).map((m) => [m.raw_name.toLowerCase(), m])
  );

  const auth = getOAuthClient();
  auth.setCredentials({ refresh_token: decrypt(settings.google_refresh_token_encrypted) });
  const gmail = google.gmail({ version: "v1", auth });

  const since = new Date();
  since.setDate(since.getDate() - LOOKBACK_DAYS);
  const afterEpoch = Math.floor(since.getTime() / 1000);
  // Build sender list dynamically from all registered card specs
  const allSenders = new Set<string>();
  for (const spec of Object.values(CARD_REGISTRY)) {
    spec.gmail.senders.forEach((s) => allSenders.add(s));
  }
  const fromClause = [...allSenders].map((s) => `from:${s}`).join(" OR ");
  const query = `(${fromClause}) after:${afterEpoch}`;

  const stream = new ReadableStream({
    async start(controller) {
      const result = { fetched: 0, parsed: 0, inserted: 0, skipped: 0, errors: [] as string[] };

      try {
        // Step 1: collect all message IDs (lightweight list calls)
        send(controller, { status: "listing", message: "Counting emails…" });
        const allIds: string[] = [];
        let pageToken: string | undefined;

        do {
          const listRes = await gmail.users.messages.list({
            userId: "me",
            q: query,
            maxResults: 100,
            pageToken,
          });
          for (const m of listRes.data.messages || []) {
            if (m.id) allIds.push(m.id);
          }
          pageToken = listRes.data.nextPageToken ?? undefined;
        } while (pageToken);

        send(controller, {
          status: "syncing",
          total: allIds.length,
          message: `Found ${allIds.length} emails. Fetching full content (this takes a few minutes on first run)…`,
        });

        // Step 2: fetch full email for each message
        for (let i = 0; i < allIds.length; i++) {
          const msgId = allIds[i];
          result.fetched++;

          // Send progress every 10 emails
          if (i % 10 === 0) {
            send(controller, {
              status: "syncing",
              fetched: result.fetched,
              total: allIds.length,
              parsed: result.parsed,
              inserted: result.inserted,
            });
          }

          try {
            const full = await gmail.users.messages.get({
              userId: "me",
              id: msgId,
              format: "full",
            });

            const headers = full.data.payload?.headers || [];
            const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
            const dateHeader = headers.find((h) => h.name?.toLowerCase() === "date")?.value;
            const fromHeader = headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
            const body = extractBody(full.data.payload);
            const snippet = full.data.snippet || "";

            const parsed = parseTxnEmail(fromHeader, subject, body, snippet);
            if (!parsed) { result.skipped++; continue; }
            result.parsed++;

            const txnAt = dateHeader ? new Date(dateHeader) : parsed.txn_at;
            const cardId = cardByLast4.get(parsed.card_last4) ?? null;

            // User-defined mapping > known-merchant cleanup > raw
            const mapping = parsed.merchant_raw
              ? merchantMap.get(parsed.merchant_raw.toLowerCase())
              : undefined;

            const cleaned = cleanMerchant(parsed.merchant_raw);
            const merchant = mapping?.normalized_name ?? cleaned ?? null;
            const category = mapping?.category ?? categorize(merchant);

            const { error } = await supabase.from("transactions").upsert(
              {
                user_id: user.id,
                card_id: cardId,
                card_last4: parsed.card_last4,
                amount_inr: parsed.amount_inr,
                merchant,
                category,
                txn_type: parsed.txn_type,
                txn_at: txnAt.toISOString(),
                gmail_message_id: msgId,
                raw_subject: subject,
                raw_body: body,
              },
              { onConflict: "user_id,gmail_message_id" }
            );

            if (error) result.errors.push(`${msgId}: ${error.message}`);
            else result.inserted++;

          } catch (e) {
            result.errors.push(`${msgId}: ${(e as Error).message}`);
          }
        }

        await supabase
          .from("user_settings")
          .update({ last_gmail_sync_at: new Date().toISOString() })
          .eq("user_id", user.id);

        send(controller, { status: "done", ...result });
      } catch (e) {
        send(controller, { status: "error", message: (e as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
