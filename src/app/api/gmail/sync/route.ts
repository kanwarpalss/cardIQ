import { google } from "googleapis";
import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/crypto";
import { parseTxnEmail } from "@/lib/parsers/registry";
import { categorize } from "@/lib/categorize";
import { cleanMerchant } from "@/lib/merchant-clean";
import { CARD_REGISTRY } from "@/lib/cards/registry";

/**
 * Fallback lookback for the very first sync only.
 * After the first sync, the cursor (last_internal_date) takes over and
 * only new emails are fetched — this constant is never used again.
 */
const FIRST_SYNC_LOOKBACK_DAYS = 365;

/**
 * Sentinel key used in gmail_sync_state to represent the combined-sender cursor.
 * We query all senders together in a single Gmail request, so one cursor covers all.
 */
const CURSOR_KEY = "_all";

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

export async function POST(req: Request) {
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

  // Load merchant mappings for instant normalization during sync.
  const { data: mappingsRaw } = await supabase
    .from("merchant_mappings")
    .select("raw_name, normalized_name, category")
    .eq("user_id", user.id);

  const merchantMap = new Map(
    (mappingsRaw || []).map((m) => [m.raw_name.toLowerCase(), m])
  );

  // ── Load the incremental sync cursor ──────────────────────────────────────
  // If a cursor exists, we only ask Gmail for messages newer than that point.
  // On first-ever sync there is no cursor — we fall back to FIRST_SYNC_LOOKBACK_DAYS.
  const { data: cursorRow } = await supabase
    .from("gmail_sync_state")
    .select("last_internal_date, message_count")
    .eq("user_id", user.id)
    .eq("sender", CURSOR_KEY)
    .maybeSingle();

  // ── Parse optional backfill override from request body ───────────────────
  // If `lookback_days` is provided, we ignore the cursor and go that far back.
  // Useful for a one-time "load full history" operation.
  const body = await req.json().catch(() => ({}));
  const backfillDays = typeof body?.lookback_days === "number" ? body.lookback_days : null;
  const isBackfill = backfillDays !== null;

  const isFirstSync = !isBackfill && !cursorRow?.last_internal_date;
  // Gmail `after:` filter takes SECONDS (not ms). Add 1s so we don't re-fetch
  // the exact boundary message (only needed for cursor mode, not backfill).
  const afterSeconds = isBackfill
    ? Math.floor((Date.now() - backfillDays * 86400 * 1000) / 1000)
    : isFirstSync
      ? Math.floor((Date.now() - FIRST_SYNC_LOOKBACK_DAYS * 86400 * 1000) / 1000)
      : Math.floor(cursorRow!.last_internal_date / 1000) + 1;

  const afterDate = new Date(afterSeconds * 1000).toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
  });

  // Build the combined-sender Gmail query.
  const allSenders = new Set<string>();
  for (const spec of Object.values(CARD_REGISTRY)) {
    spec.gmail.senders.forEach((s) => allSenders.add(s));
  }
  const fromClause = [...allSenders].map((s) => `from:${s}`).join(" OR ");
  const query = `(${fromClause}) after:${afterSeconds}`;

  const auth = getOAuthClient();
  auth.setCredentials({ refresh_token: decrypt(settings.google_refresh_token_encrypted) });
  const gmail = google.gmail({ version: "v1", auth });

  // ── Pre-load existing Gmail message IDs so we can tell new vs. already-stored ──
  // This is a lightweight query (IDs only). Having this set lets us report
  // accurate "new transactions" counts instead of misleadingly counting all upserts.
  const { data: existingMsgRows } = await supabase
    .from("transactions")
    .select("gmail_message_id")
    .eq("user_id", user.id);
  const knownMsgIds = new Set<string>(
    (existingMsgRows || []).map((r) => r.gmail_message_id).filter(Boolean)
  );

  const stream = new ReadableStream({
    async start(controller) {
      const result = {
        fetched: 0, parsed: 0,
        new_txns: 0,    // genuinely new records (not previously in DB)
        updated: 0,     // already existed — upsert refreshed them
        skipped: 0,
        errors: [] as string[],
        is_first_sync: isFirstSync,
        is_backfill: isBackfill,
      };

      // Tracks the newest internalDate seen across all fetched messages.
      // We use this to advance the cursor after a successful sync.
      let maxInternalDate = cursorRow?.last_internal_date ?? 0;

      try {
        // ── Step 1: list all matching message IDs (lightweight, no body) ──
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

        // ── Nothing new since last sync ────────────────────────────────────
        if (allIds.length === 0) {
          send(controller, {
            status: "done",
            ...result,
            message: "Already up to date — no new emails.",
          });
          controller.close();
          return;
        }

        // ── Filter out IDs we already have in the DB ──────────────────────
        // knownMsgIds was built before the stream started. Any ID already there
        // is already parsed + stored — no point re-downloading the email body.
        const idsToFetch = allIds.filter((id) => !knownMsgIds.has(id));
        result.updated += allIds.length - idsToFetch.length; // count skipped as already-done

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

        // ── Step 2: fetch full email only for IDs not already in the DB ───
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

          try {
            const full = await gmail.users.messages.get({
              userId: "me",
              id: msgId,
              format: "full",
            });

            // Track the newest message timestamp to advance the cursor.
            const msgInternalDate = parseInt(full.data.internalDate ?? "0", 10);
            if (msgInternalDate > maxInternalDate) maxInternalDate = msgInternalDate;

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

            // Two-pass merchant lookup:
            // 1st: exact raw name from email parser (e.g. "SWIGGY*MUMBAI")
            // 2nd: cleaned name (e.g. "Swiggy") — picks up UI display-name overrides
            const rawKey = parsed.merchant_raw?.toLowerCase() ?? "";
            const cleaned = cleanMerchant(parsed.merchant_raw);
            const cleanedKey = cleaned?.toLowerCase() ?? "";
            const mapping = (rawKey ? merchantMap.get(rawKey) : undefined)
              ?? (cleanedKey ? merchantMap.get(cleanedKey) : undefined);

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

            if (error) {
              result.errors.push(`${msgId}: ${error.message}`);
            } else {
              if (knownMsgIds.has(msgId)) result.updated++;
              else { result.new_txns++; knownMsgIds.add(msgId); }
            }

          } catch (e) {
            result.errors.push(`${msgId}: ${(e as Error).message}`);
          }
        }

        // ── Advance the cursor & record coverage ───────────────────────────
        // Only persist if we actually processed something without a fatal error.
        if (maxInternalDate > 0) {
          await supabase
            .from("gmail_sync_state")
            .upsert({
              user_id: user.id,
              sender: CURSOR_KEY,
              last_internal_date: maxInternalDate,
              last_synced_at: new Date().toISOString(),
              message_count: (cursorRow?.message_count ?? 0) + result.fetched,
            }, { onConflict: "user_id,sender" });

          // Record the covered date range for this sync run.
          await supabase.from("gmail_sync_ranges").insert({
            user_id: user.id,
            sender: CURSOR_KEY,
            range_start: new Date(afterSeconds * 1000).toISOString().slice(0, 10),
            range_end: new Date().toISOString().slice(0, 10),
          });
        }

        // Keep legacy last_gmail_sync_at in user_settings for backwards compat.
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
