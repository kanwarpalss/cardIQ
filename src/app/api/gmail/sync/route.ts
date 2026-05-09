import { google } from "googleapis";
import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/crypto";
import { parseTxnEmailWithFallback } from "@/lib/parsers/registry";
import { categorize } from "@/lib/categorize";
import { cleanMerchant } from "@/lib/merchant-clean";
import { CARD_REGISTRY } from "@/lib/cards/registry";

/**
 * Lookback window for the very first ever sync only.
 * Once a cursor is saved in gmail_sync_state, this constant is never used again.
 * Subsequent syncs only fetch emails newer than the cursor — regardless of
 * what date-range the user has selected in the UI (that filter is view-only).
 */
const FIRST_SYNC_LOOKBACK_DAYS = 365;

/**
 * Sentinel key stored in gmail_sync_state to represent the single combined query.
 * We query all bank senders together, so one cursor row covers the whole account.
 */
const CURSOR_KEY = "_all";

// ─── helpers ────────────────────────────────────────────────────────────────

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

// ─── route ──────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });

  // ── Fail fast on missing env vars ────────────────────────────────────────
  // Without GOOGLE_CLIENT_ID/SECRET the OAuth2 client cannot exchange the
  // refresh token for an access token. The first Gmail API call fails ~3s in
  // and the streaming response just dies silently. Surface it loudly instead.
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.error("[gmail/sync] FATAL: GOOGLE_CLIENT_ID and/or GOOGLE_CLIENT_SECRET missing from .env.local");
    return new Response(
      JSON.stringify({
        error: "missing_google_credentials",
        message: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env.local. Restart the dev server after adding them.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

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

  // ── Cards & merchant mappings ────────────────────────────────────────────
  const { data: cards } = await supabase
    .from("cards")
    .select("id, last4")
    .eq("user_id", user.id);

  const cardByLast4 = new Map((cards || []).map((c) => [c.last4, c.id]));
  const knownLast4s = new Set((cards || []).map((c) => c.last4));

  const { data: mappingsRaw } = await supabase
    .from("merchant_mappings")
    .select("raw_name, normalized_name, category")
    .eq("user_id", user.id);

  const merchantMap = new Map(
    (mappingsRaw || []).map((m) => [m.raw_name.toLowerCase(), m])
  );

  // ── Read the forward cursor ───────────────────────────────────────────────
  // gmail_sync_state holds the internalDate (ms) of the most-recent email
  // we have ever downloaded. The next sync queries Gmail for messages AFTER
  // this point, so we never re-fetch the same time range.
  //
  // If the cursor is missing (first ever sync, or the table was just created),
  // we fall back to FIRST_SYNC_LOOKBACK_DAYS and write the cursor afterward.
  const { data: cursorRow, error: cursorErr } = await supabase
    .from("gmail_sync_state")
    .select("last_internal_date, message_count")
    .eq("user_id", user.id)
    .eq("sender", CURSOR_KEY)
    .maybeSingle();

  if (cursorErr) {
    console.error("[gmail/sync] cursor read error:", cursorErr.message);
  }

  // ── Parse optional backfill override from request body ───────────────────
  // The UI's date-range filter is VIEW-ONLY — it never affects what we fetch
  // from Gmail. This is the only legitimate way to expand the fetch window,
  // and only new (not-yet-seen) message IDs will actually be downloaded.
  const body = await req.json().catch(() => ({}));
  const backfillDays = typeof body?.lookback_days === "number" ? body.lookback_days : null;
  const isBackfill = backfillDays !== null;

  const isFirstSync = !isBackfill && !cursorRow?.last_internal_date;

  // Gmail `after:` filter expects UNIX seconds (not ms). Add 1s on cursor mode
  // to avoid re-fetching the exact boundary message.
  const afterSeconds = isBackfill
    ? Math.floor((Date.now() - backfillDays! * 86400 * 1000) / 1000)
    : isFirstSync
      ? Math.floor((Date.now() - FIRST_SYNC_LOOKBACK_DAYS * 86400 * 1000) / 1000)
      : Math.floor(cursorRow!.last_internal_date / 1000) + 1;

  const afterDate = new Date(afterSeconds * 1000).toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
  });

  // ── Build the combined-sender Gmail query ────────────────────────────────
  const allSenders = new Set<string>();
  for (const spec of Object.values(CARD_REGISTRY)) {
    spec.gmail.senders.forEach((s) => allSenders.add(s));
  }
  const fromClause = [...allSenders].map((s) => `from:${s}`).join(" OR ");
  const query = `(${fromClause}) after:${afterSeconds}`;

  const auth = getOAuthClient();
  auth.setCredentials({ refresh_token: decrypt(settings.google_refresh_token_encrypted) });
  const gmail = google.gmail({ version: "v1", auth });

  // ── Pre-load ALL previously-seen Gmail message IDs ────────────────────────
  // gmail_seen_messages is our permanent "never re-download" ledger. Every
  // message we fetch (transaction OR skipped/non-transactional) gets recorded
  // there after processing. This means:
  //   • Changing the lookback window does NOT re-download already-seen emails.
  //   • Adding a new card does NOT trigger re-downloading old emails — the
  //     parser re-runs on the already-stored raw_body if needed instead.
  //   • Only genuinely new Gmail message IDs (not in this set) get fetched.
  //
  // We also query the transactions table as a fallback for emails that were
  // synced before migration 006 created gmail_seen_messages.
  const [txnRows, seenRows] = await Promise.all([
    supabase.from("transactions").select("gmail_message_id").eq("user_id", user.id),
    supabase.from("gmail_seen_messages").select("gmail_message_id").eq("user_id", user.id),
  ]);

  if (seenRows.error) {
    console.error("[gmail/sync] gmail_seen_messages read error — did you run migration 006?", seenRows.error.message);
  }

  const knownMsgIds = new Set<string>([
    ...(txnRows.data || []).map((r) => r.gmail_message_id).filter(Boolean),
    ...(seenRows.data || []).map((r) => r.gmail_message_id).filter(Boolean),
  ]);

  // ── Streaming response ────────────────────────────────────────────────────
  const stream = new ReadableStream({
    async start(controller) {
      const result = {
        fetched: 0,
        parsed: 0,
        new_txns: 0,
        updated: 0,    // already in DB — upsert was a no-op
        skipped: 0,
        errors: [] as string[],
        is_first_sync: isFirstSync,
        is_backfill: isBackfill,
      };

      // Highest internalDate (ms) seen across all fetched messages.
      // Advances the cursor at the end so future syncs start from here.
      let maxInternalDate: number = cursorRow?.last_internal_date ?? 0;

      try {
        // ── Step 1: list matching message IDs (lightweight) ────────────────
        send(controller, {
          status: "listing",
          message: isBackfill
            ? `Full history backfill — counting emails since ${afterDate}…`
            : isFirstSync
              ? "First sync — counting all emails…"
              : `Checking for new emails since ${afterDate}…`,
        });

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

        if (allIds.length === 0) {
          send(controller, {
            status: "done",
            ...result,
            message: "Already up to date — no new emails.",
          });
          controller.close();
          return;
        }

        // ── Filter: skip IDs we've already downloaded ─────────────────────
        // knownMsgIds was built from both gmail_seen_messages AND transactions,
        // so any email we've ever fetched (transactional or not) is excluded.
        const idsToFetch = allIds.filter((id) => !knownMsgIds.has(id));
        result.updated += allIds.length - idsToFetch.length;

        if (idsToFetch.length === 0) {
          send(controller, {
            status: "done",
            ...result,
            message: `Already up to date — ${allIds.length} emails checked, all already in your database.`,
          });
          controller.close();
          return;
        }

        send(controller, {
          status: "syncing",
          total: idsToFetch.length,
          message: isBackfill
            ? `Found ${allIds.length} emails since ${afterDate}. ${idsToFetch.length} are new — fetching those now…`
            : isFirstSync
              ? `Found ${idsToFetch.length} emails. Fetching full content (first sync — this takes a few minutes)…`
              : `Found ${idsToFetch.length} new email${idsToFetch.length === 1 ? "" : "s"} since ${afterDate}. Fetching…`,
        });

        // ── Step 2: fetch & process only unseen emails ────────────────────
        // After each email (whether it parses into a transaction or gets
        // skipped), we record its ID in gmail_seen_messages so it is NEVER
        // re-downloaded on any future sync run — regardless of what lookback
        // window the user selects. This is the "once and forever" guarantee.
        //
        // We batch writes every 50 emails to reduce DB round-trips.
        const seenBatch: Array<{
          user_id: string;
          gmail_message_id: string;
          txn_id: string | null;
          raw_subject: string;
          raw_body: string;
          raw_from: string;
          internal_date: number;
        }> = [];

        async function flushSeenBatch() {
          if (!seenBatch.length) return;
          const rows = seenBatch.splice(0);
          const { error } = await supabase
            .from("gmail_seen_messages")
            .upsert(rows, { onConflict: "user_id,gmail_message_id" });
          if (error) {
            console.error(
              `[gmail/sync] WARN: failed to record ${rows.length} seen IDs \u2014 did you run migrations 006 + 007?`,
              error.message
            );
            result.errors.push(`seen-batch flush failed: ${error.message}`);
          }
        }

        for (let i = 0; i < idsToFetch.length; i++) {
          const msgId = idsToFetch[i];
          result.fetched++;

          if (i % 10 === 0) {
            send(controller, {
              status: "syncing",
              fetched: result.fetched,
              total: idsToFetch.length,
              parsed: result.parsed,
              new_txns: result.new_txns,
            });
          }

          let insertedTxnId: string | null = null;
          // Captured outside the try so the seen-record write below has access
          // even when the parse/upsert path threw partway through.
          let lastSubject = "";
          let lastBody = "";
          let lastFrom = "";
          let lastInternalDate = 0;

          try {
            const full = await gmail.users.messages.get({
              userId: "me",
              id: msgId,
              format: "full",
            });

            const msgInternalDate = parseInt(full.data.internalDate ?? "0", 10);
            if (msgInternalDate > maxInternalDate) maxInternalDate = msgInternalDate;
            lastInternalDate = msgInternalDate;

            const headers = full.data.payload?.headers || [];
            const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
            const dateHeader = headers.find((h) => h.name?.toLowerCase() === "date")?.value;
            const fromHeader = headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
            const emailBody = extractBody(full.data.payload);
            const snippet = full.data.snippet || "";

            lastSubject = subject;
            lastBody = emailBody;
            lastFrom = fromHeader;

            const parsed = parseTxnEmailWithFallback(fromHeader, subject, emailBody, snippet, knownLast4s);

            if (!parsed) {
              result.skipped++;
              // Not a transaction — mark as seen WITH the raw body so future
              // parser improvements can retry it locally w-hitting Gmail.
              seenBatch.push({
                user_id: user!.id,
                gmail_message_id: msgId,
                txn_id: null,
                raw_subject: subject,
                raw_body: emailBody,
                raw_from: fromHeader,
                internal_date: msgInternalDate,
              });
              if (seenBatch.length >= 50) await flushSeenBatch();
              continue;
            }

            result.parsed++;

            const txnAt = dateHeader ? new Date(dateHeader) : parsed.txn_at;
            const cardId = cardByLast4.get(parsed.card_last4) ?? null;

            const rawKey = parsed.merchant_raw?.toLowerCase() ?? "";
            const cleaned = cleanMerchant(parsed.merchant_raw);
            const cleanedKey = cleaned?.toLowerCase() ?? "";
            const mapping =
              (rawKey ? merchantMap.get(rawKey) : undefined) ??
              (cleanedKey ? merchantMap.get(cleanedKey) : undefined);

            const merchant = mapping?.normalized_name ?? cleaned ?? null;
            const category = mapping?.category ?? categorize(merchant);

            const { data: upserted, error: upsertErr } = await supabase
              .from("transactions")
              .upsert(
                {
                  user_id: user!.id,
                  card_id: cardId,
                  card_last4: parsed.card_last4,
                  amount_inr: parsed.amount_inr,
                  // Foreign-currency txns: store original side-by-side so we
                  // can later show "USD 224.28 (₹18,923)" instead of just INR.
                  original_currency: parsed.currency ?? "INR",
                  original_amount: parsed.amount_original ?? parsed.amount_inr,
                  // Generic-sniffer matches are flagged for user review since
                  // they didn't match a bank-specific parser — amount/merchant
                  // could be a hair off vs. the canonical format.
                  low_confidence: parsed.low_confidence ?? false,
                  merchant,
                  category,
                  txn_type: parsed.txn_type,
                  txn_at: txnAt.toISOString(),
                  gmail_message_id: msgId,
                  raw_subject: subject,
                  raw_body: emailBody,
                },
                { onConflict: "user_id,gmail_message_id" }
              )
              .select("id")
              .maybeSingle();

            if (upsertErr) {
              result.errors.push(`txn upsert ${msgId}: ${upsertErr.message}`);
            } else {
              if (knownMsgIds.has(msgId)) {
                result.updated++;
              } else {
                result.new_txns++;
                knownMsgIds.add(msgId);
              }
              insertedTxnId = upserted?.id ?? null;
            }
          } catch (e) {
            result.errors.push(`fetch ${msgId}: ${(e as Error).message}`);
            // Still mark as seen — retrying a network error is fine, but
            // retrying a parse failure just wastes time. The raw email body
            // is stored in the transactions table if parsing succeeded.
          }

          // Always record the message ID so it's never re-downloaded,
          // even if parsing or the DB upsert failed. Store the raw body so
          // future parser improvements can re-categorize without re-fetching.
          seenBatch.push({
            user_id: user!.id,
            gmail_message_id: msgId,
            txn_id: insertedTxnId,
            raw_subject: lastSubject,
            raw_body: lastBody,
            raw_from: lastFrom,
            internal_date: lastInternalDate,
          });
          if (seenBatch.length >= 50) await flushSeenBatch();
        }

        // Flush any remaining seen IDs.
        await flushSeenBatch();

        // ── Advance the cursor ────────────────────────────────────────────
        // This MUST happen after processing so future syncs start from after
        // the newest email we just downloaded. Wrapped in its own try/catch
        // so a DB error here doesn't kill the response the client is reading.
        if (maxInternalDate > 0) {
          const { error: cursorSaveErr } = await supabase
            .from("gmail_sync_state")
            .upsert(
              {
                user_id: user!.id,
                sender: CURSOR_KEY,
                last_internal_date: maxInternalDate,
                last_synced_at: new Date().toISOString(),
                message_count: (cursorRow?.message_count ?? 0) + result.fetched,
              },
              { onConflict: "user_id,sender" }
            );

          if (cursorSaveErr) {
            console.error("[gmail/sync] CRITICAL: cursor save failed — next sync will restart from the beginning!", cursorSaveErr.message);
            result.errors.push(`cursor save failed: ${cursorSaveErr.message} — did you run migration 004?`);
          } else {
            // Record the covered date range for this sync run (append-only log).
            await supabase.from("gmail_sync_ranges").insert({
              user_id: user!.id,
              sender: CURSOR_KEY,
              range_start: new Date(afterSeconds * 1000).toISOString().slice(0, 10),
              range_end: new Date().toISOString().slice(0, 10),
            });
          }
        }

        // Keep legacy last_gmail_sync_at for backwards compatibility.
        await supabase
          .from("user_settings")
          .update({ last_gmail_sync_at: new Date().toISOString() })
          .eq("user_id", user!.id);

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
