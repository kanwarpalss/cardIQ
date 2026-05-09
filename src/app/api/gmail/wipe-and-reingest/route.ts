import { google } from "googleapis";
import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/crypto";
import { parseTxnEmailWithFallback } from "@/lib/parsers/registry";
import { categorize } from "@/lib/categorize";
import { cleanMerchant } from "@/lib/merchant-clean";
import { CARD_REGISTRY } from "@/lib/cards/registry";

/**
 * The big red button. Wipes all transactions + sync state for the current
 * user and re-ingests the last N years of bank emails from scratch.
 *
 * Required confirmation: POST { confirm: "WIPE-AND-REINGEST", years: 8 }
 *
 * Why a separate endpoint instead of "delete + sync"?
 *   • Atomic mental model: one click, one operation.
 *   • Skips the cursor entirely — no risk of an old cursor leaking through.
 *   • Cleans gmail_seen_messages too, so every email is truly re-fetched
 *     and re-parsed with the current parser (not just historical leftovers).
 *
 * Streams progress as newline-delimited JSON.
 */

const DEFAULT_YEARS = 8;
const MAX_YEARS = 15;

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
      JSON.stringify({ error: "missing_google_credentials" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const body = await req.json().catch(() => ({}));

  // Safety: require explicit confirmation string. No accidental nukes.
  if (body?.confirm !== "WIPE-AND-REINGEST") {
    return new Response(
      JSON.stringify({
        error: "confirmation_required",
        message: 'POST { "confirm": "WIPE-AND-REINGEST", "years": 8 } to proceed.',
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const years = Math.min(Math.max(parseInt(body?.years ?? DEFAULT_YEARS, 10), 1), MAX_YEARS);

  // ── Settings + cards + mappings (load once) ────────────────────────────────
  const [settingsRes, cardsRes, mappingsRes] = await Promise.all([
    supabase.from("user_settings").select("google_refresh_token_encrypted").eq("user_id", user.id).single(),
    supabase.from("cards").select("id, last4").eq("user_id", user.id),
    supabase.from("merchant_mappings").select("raw_name, normalized_name, category").eq("user_id", user.id),
  ]);

  if (!settingsRes.data?.google_refresh_token_encrypted) {
    return new Response(
      JSON.stringify({ error: "no_refresh_token", message: "Sign out and sign in again." }),
      { status: 400 }
    );
  }

  const cardByLast4 = new Map((cardsRes.data || []).map((c) => [c.last4, c.id]));
  const knownLast4s = new Set((cardsRes.data || []).map((c) => c.last4));
  const merchantMap = new Map((mappingsRes.data || []).map((m) => [m.raw_name.toLowerCase(), m]));

  const auth = getOAuthClient();
  auth.setCredentials({ refresh_token: decrypt(settingsRes.data.google_refresh_token_encrypted) });
  const gmail = google.gmail({ version: "v1", auth });

  // ── Build Gmail query ──────────────────────────────────────────────────────
  const allSenders = new Set<string>();
  for (const spec of Object.values(CARD_REGISTRY)) {
    spec.gmail.senders.forEach((s) => allSenders.add(s));
  }
  const fromClause = [...allSenders].map((s) => `from:${s}`).join(" OR ");
  const afterSeconds = Math.floor((Date.now() - years * 365 * 86400 * 1000) / 1000);
  const query = `(${fromClause}) after:${afterSeconds}`;

  const stream = new ReadableStream({
    async start(controller) {
      const result = {
        deleted_transactions: 0,
        deleted_seen: 0,
        listed: 0,
        fetched: 0,
        parsed: 0,
        new_txns: 0,
        skipped: 0,
        errors: [] as string[],
        years,
      };

      try {
        // ── PHASE 1: WIPE ───────────────────────────────────────────────────
        send(controller, { status: "wiping", message: "Deleting transactions, seen-messages, and sync state…" });

        const [delTxn, delSeen] = await Promise.all([
          supabase.from("transactions").delete({ count: "exact" }).eq("user_id", user.id),
          supabase.from("gmail_seen_messages").delete({ count: "exact" }).eq("user_id", user.id),
        ]);
        result.deleted_transactions = delTxn.count ?? 0;
        result.deleted_seen = delSeen.count ?? 0;

        // Reset cursor so the FIRST_SYNC_LOOKBACK_DAYS path won't accidentally
        // shrink our window. We use the explicit `years` lookback below.
        await supabase.from("gmail_sync_state").delete().eq("user_id", user.id);
        await supabase.from("gmail_sync_ranges").delete().eq("user_id", user.id);

        send(controller, {
          status: "wiped",
          deleted_transactions: result.deleted_transactions,
          deleted_seen: result.deleted_seen,
          message: `Wiped ${result.deleted_transactions} transactions and ${result.deleted_seen} seen-message records. Listing emails from Gmail…`,
        });

        // ── PHASE 2: LIST all matching message IDs ──────────────────────────
        const allIds: string[] = [];
        let pageToken: string | undefined;
        do {
          const r = await gmail.users.messages.list({
            userId: "me", q: query, maxResults: 500, pageToken,
          });
          for (const m of r.data.messages || []) if (m.id) allIds.push(m.id);
          pageToken = r.data.nextPageToken ?? undefined;
          if (allIds.length % 1000 === 0 && allIds.length > 0) {
            send(controller, { status: "listing", listed: allIds.length, message: `Listed ${allIds.length} emails…` });
          }
        } while (pageToken);

        result.listed = allIds.length;
        send(controller, { status: "listed", total: allIds.length, message: `Found ${allIds.length} emails. Fetching & parsing…` });

        if (allIds.length === 0) {
          send(controller, { status: "done", ...result, message: "No matching emails found." });
          controller.close();
          return;
        }

        // ── PHASE 3: FETCH + PARSE + INSERT ────────────────────────────────
        // We batch-write seen-messages every 50 to reduce DB round-trips.
        const seenBatch: Array<{
          user_id: string;
          gmail_message_id: string;
          txn_id: string | null;
          raw_subject: string;
          raw_body: string;
          raw_from: string;
          internal_date: number;
        }> = [];

        let maxInternalDate = 0;

        async function flushSeen() {
          if (!seenBatch.length) return;
          const rows = seenBatch.splice(0);
          const { error } = await supabase
            .from("gmail_seen_messages")
            .upsert(rows, { onConflict: "user_id,gmail_message_id" });
          if (error) result.errors.push(`seen flush: ${error.message}`);
        }

        for (let i = 0; i < allIds.length; i++) {
          const msgId = allIds[i];
          result.fetched++;

          if (i % 25 === 0) {
            send(controller, {
              status: "ingesting",
              fetched: result.fetched,
              total: allIds.length,
              new_txns: result.new_txns,
              parsed: result.parsed,
              skipped: result.skipped,
            });
          }

          let subject = "", fromHdr = "", bodyTxt = "", internalDate = 0;
          let insertedTxnId: string | null = null;

          try {
            const full = await gmail.users.messages.get({ userId: "me", id: msgId, format: "full" });
            const headers = full.data.payload?.headers || [];
            subject  = headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
            fromHdr  = headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
            bodyTxt  = extractBody(full.data.payload);
            internalDate = parseInt(full.data.internalDate ?? "0", 10);
            if (internalDate > maxInternalDate) maxInternalDate = internalDate;

            const parsed = parseTxnEmailWithFallback(fromHdr, subject, bodyTxt, full.data.snippet || "", knownLast4s);

            if (parsed) {
              result.parsed++;

              const cardId = cardByLast4.get(parsed.card_last4) ?? null;
              const rawKey = parsed.merchant_raw?.toLowerCase() ?? "";
              const cleaned = cleanMerchant(parsed.merchant_raw);
              const cleanedK = cleaned?.toLowerCase() ?? "";
              const mapping = (rawKey && merchantMap.get(rawKey)) || (cleanedK && merchantMap.get(cleanedK)) || null;
              const merchant = mapping?.normalized_name ?? cleaned ?? null;
              const category = mapping?.category ?? categorize(merchant);

              const { data: upserted, error: upsertErr } = await supabase
                .from("transactions")
                .upsert(
                  {
                    user_id: user.id,
                    card_id: cardId,
                    card_last4: parsed.card_last4,
                    amount_inr: parsed.amount_inr,
                    original_currency: parsed.currency ?? "INR",
                    original_amount: parsed.amount_original ?? parsed.amount_inr,
                    low_confidence: parsed.low_confidence ?? false,
                    merchant,
                    category,
                    txn_type: parsed.txn_type,
                    txn_at: internalDate > 0 ? new Date(internalDate).toISOString() : parsed.txn_at.toISOString(),
                    gmail_message_id: msgId,
                    raw_subject: subject,
                    raw_body: bodyTxt,
                  },
                  { onConflict: "user_id,gmail_message_id" }
                )
                .select("id")
                .maybeSingle();

              if (upsertErr) {
                result.errors.push(`txn ${msgId}: ${upsertErr.message}`);
              } else {
                result.new_txns++;
                insertedTxnId = upserted?.id ?? null;
              }
            } else {
              result.skipped++;
            }
          } catch (e) {
            result.errors.push(`fetch ${msgId}: ${(e as Error).message}`);
          }

          seenBatch.push({
            user_id: user.id,
            gmail_message_id: msgId,
            txn_id: insertedTxnId,
            raw_subject: subject,
            raw_body: bodyTxt,
            raw_from: fromHdr,
            internal_date: internalDate,
          });
          if (seenBatch.length >= 50) await flushSeen();
        }
        await flushSeen();

        // ── PHASE 4: write fresh cursor ────────────────────────────────────
        if (maxInternalDate > 0) {
          await supabase.from("gmail_sync_state").upsert(
            {
              user_id: user.id,
              sender: "_all",
              last_internal_date: maxInternalDate,
              last_synced_at: new Date().toISOString(),
              message_count: result.fetched,
            },
            { onConflict: "user_id,sender" }
          );
        }

        await supabase
          .from("user_settings")
          .update({ last_gmail_sync_at: new Date().toISOString() })
          .eq("user_id", user.id);

        send(controller, { status: "done", ...result });
      } catch (e) {
        send(controller, { status: "error", message: (e as Error).message, ...result });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" },
  });
}
