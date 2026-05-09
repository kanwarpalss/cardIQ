import { google } from "googleapis";
import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/crypto";
import { parseTxnEmail } from "@/lib/parsers/registry";
import { categorize } from "@/lib/categorize";
import { cleanMerchant } from "@/lib/merchant-clean";

/**
 * Reprocess emails that are in gmail_seen_messages but did NOT produce a
 * transaction (txn_id IS NULL). Useful when:
 *   • Parsers have improved (e.g. now handle USD)
 *   • Sync ran during a broken state and silently dropped emails
 *
 * Two phases per request:
 *
 *   PHASE A — OFFLINE retry (fast, no Gmail calls)
 *     For rows that already have raw_body (added in migration 007),
 *     just re-run the parser locally. No quota, no network beyond Supabase.
 *
 *   PHASE B — ONLINE recovery (one-time, slow)
 *     For legacy rows with NULL raw_body (synced before migration 007),
 *     re-fetch the full email from Gmail, run the parser, and backfill
 *     raw_body so the next reprocess can stay offline.
 *
 *  Request body (all optional):
 *    { online: boolean = false   // true = also do PHASE B
 *      limit:  number  = 5000    // safety cap on rows touched per call
 *    }
 *
 *  Streams progress as newline-delimited JSON, same as /api/gmail/sync.
 */

const ONLINE_FETCH_HARD_CAP = 1500;   // never re-fetch more than this in one call

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
    .replace(/\s+/g, " ")
    .trim();
}

function extractBody(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return base64Decode(payload.body.data);
  if (payload.mimeType === "text/html"  && payload.body?.data) return stripHtml(base64Decode(payload.body.data));
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
    for (const part of payload.parts) {
      const body = extractBody(part);
      if (body) return body;
    }
  }
  return "";
}

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return new Response(
      JSON.stringify({ error: "missing_google_credentials", message: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const body = await req.json().catch(() => ({}));
  const online = body?.online === true;
  const limit  = Math.min(parseInt(body?.limit ?? "5000", 10), 10000);

  // Cards & merchant mappings (mirrors sync route).
  const [cardsRes, mappingsRes] = await Promise.all([
    supabase.from("cards").select("id, last4").eq("user_id", user.id),
    supabase.from("merchant_mappings").select("raw_name, normalized_name, category").eq("user_id", user.id),
  ]);
  const cardByLast4 = new Map((cardsRes.data || []).map((c) => [c.last4, c.id]));
  const merchantMap = new Map((mappingsRes.data || []).map((m) => [m.raw_name.toLowerCase(), m]));

  const stream = new ReadableStream({
    async start(controller) {
      const result = {
        offline_retried: 0,
        online_refetched: 0,
        new_txns: 0,
        still_no_match: 0,
        errors: [] as string[],
      };

      try {
        // ── PHASE A: offline retry on rows that already have raw_body ─────
        send(controller, { status: "offline_start", message: "Re-parsing emails with stored bodies…" });

        const { data: offlineRows, error: offlineErr } = await supabase
          .from("gmail_seen_messages")
          .select("gmail_message_id, raw_subject, raw_body, raw_from, internal_date")
          .eq("user_id", user.id)
          .is("txn_id", null)
          .not("raw_body", "is", null)
          .limit(limit);

        if (offlineErr) {
          result.errors.push(`offline read: ${offlineErr.message}`);
        }

        for (const row of offlineRows || []) {
          result.offline_retried++;
          if (result.offline_retried % 100 === 0) {
            send(controller, { status: "offline_progress", ...result });
          }

          const parsed = parseTxnEmail(row.raw_from || "", row.raw_subject || "", row.raw_body || "", "");
          if (!parsed) {
            result.still_no_match++;
            continue;
          }

          await upsertTxnAndLink(parsed, row.gmail_message_id, row.raw_subject || "", row.raw_body || "", row.internal_date);
        }

        // ── PHASE B (optional): re-fetch legacy rows with NULL raw_body ───
        if (online) {
          send(controller, { status: "online_start", message: "Re-fetching legacy emails from Gmail…" });

          const { data: settings } = await supabase
            .from("user_settings")
            .select("google_refresh_token_encrypted")
            .eq("user_id", user.id)
            .single();

          if (!settings?.google_refresh_token_encrypted) {
            throw new Error("No Google refresh token. Sign out and back in.");
          }

          const auth = getOAuthClient();
          auth.setCredentials({ refresh_token: decrypt(settings.google_refresh_token_encrypted) });
          const gmail = google.gmail({ version: "v1", auth });

          const { data: legacyRows, error: legacyErr } = await supabase
            .from("gmail_seen_messages")
            .select("gmail_message_id")
            .eq("user_id", user.id)
            .is("txn_id", null)
            .is("raw_body", null)
            .limit(Math.min(limit, ONLINE_FETCH_HARD_CAP));

          if (legacyErr) result.errors.push(`legacy read: ${legacyErr.message}`);

          send(controller, {
            status: "online_progress",
            total: legacyRows?.length ?? 0,
            ...result,
          });

          for (const row of legacyRows || []) {
            result.online_refetched++;
            if (result.online_refetched % 25 === 0) {
              send(controller, { status: "online_progress", ...result, total: legacyRows?.length });
            }

            try {
              const full = await gmail.users.messages.get({ userId: "me", id: row.gmail_message_id, format: "full" });
              const headers = full.data.payload?.headers || [];
              const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
              const fromHdr = headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
              const bodyTxt = extractBody(full.data.payload);
              const internalDate = parseInt(full.data.internalDate ?? "0", 10);

              const parsed = parseTxnEmail(fromHdr, subject, bodyTxt, full.data.snippet || "");

              if (parsed) {
                await upsertTxnAndLink(parsed, row.gmail_message_id, subject, bodyTxt, internalDate, fromHdr);
              } else {
                result.still_no_match++;
                // Backfill the raw body so future offline retries are instant.
                await supabase
                  .from("gmail_seen_messages")
                  .update({ raw_subject: subject, raw_body: bodyTxt, raw_from: fromHdr, internal_date: internalDate })
                  .eq("user_id", user.id)
                  .eq("gmail_message_id", row.gmail_message_id);
              }
            } catch (e) {
              result.errors.push(`fetch ${row.gmail_message_id}: ${(e as Error).message}`);
            }
          }
        }

        send(controller, { status: "done", ...result });
      } catch (e) {
        send(controller, { status: "error", message: (e as Error).message, ...result });
      } finally {
        controller.close();
      }

      // ─── helper: insert/update txn and link to seen row ───────────────────
      async function upsertTxnAndLink(
        parsed: ReturnType<typeof parseTxnEmail>,
        msgId: string,
        subject: string,
        bodyTxt: string,
        internalDate: number,
        fromHdr?: string,
      ) {
        if (!parsed) return;
        const cardId = cardByLast4.get(parsed.card_last4) ?? null;

        const rawKey   = parsed.merchant_raw?.toLowerCase() ?? "";
        const cleaned  = cleanMerchant(parsed.merchant_raw);
        const cleanedK = cleaned?.toLowerCase() ?? "";
        const mapping  = (rawKey && merchantMap.get(rawKey)) || (cleanedK && merchantMap.get(cleanedK)) || null;
        const merchant = mapping?.normalized_name ?? cleaned ?? null;
        const category = mapping?.category ?? categorize(merchant);

        const txnAt = internalDate > 0 ? new Date(internalDate) : parsed.txn_at;

        const { data: upserted, error: upsertErr } = await supabase
          .from("transactions")
          .upsert(
            {
              user_id: user!.id,
              card_id: cardId,
              card_last4: parsed.card_last4,
              amount_inr: parsed.amount_inr,
              original_currency: parsed.currency ?? "INR",
              original_amount: parsed.amount_original ?? parsed.amount_inr,
              merchant,
              category,
              txn_type: parsed.txn_type,
              txn_at: txnAt.toISOString(),
              gmail_message_id: msgId,
              raw_subject: subject,
              raw_body: bodyTxt,
            },
            { onConflict: "user_id,gmail_message_id" }
          )
          .select("id")
          .maybeSingle();

        if (upsertErr) {
          result.errors.push(`txn upsert ${msgId}: ${upsertErr.message}`);
          return;
        }

        result.new_txns++;

        // Link the seen row to the new transaction & ensure body is saved.
        await supabase
          .from("gmail_seen_messages")
          .update({
            txn_id: upserted?.id ?? null,
            raw_subject: subject,
            raw_body: bodyTxt,
            ...(fromHdr ? { raw_from: fromHdr } : {}),
            ...(internalDate > 0 ? { internal_date: internalDate } : {}),
          })
          .eq("user_id", user!.id)
          .eq("gmail_message_id", msgId);
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" },
  });
}
