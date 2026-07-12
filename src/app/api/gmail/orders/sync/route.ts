import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/crypto";
import { google } from "googleapis";
import {
  makeGmailOAuthClient,
  extractBody,
  extractHtml,
} from "@/lib/gmail/extract";
import { friendlyGmailSyncError } from "@/lib/gmail/errors";
import { isMissingTableError, isMissingColumnError } from "@/lib/supabase/errors";
import { parseOrderEmail, ORDER_DISCOVERY_CLAUSES, type OrderSource } from "@/lib/parsers/orders/registry";
import { matchOrderToTxn, orderMatchRank, reviewStatusFor, type TxnLite, type MatchConfidence } from "@/lib/order-match";

/**
 * Order-email sync (V2 feature C) — the second Gmail pass, structurally a
 * sibling of /api/gmail/sync (bank pass). Same ARCH-12 trio:
 *   cursor          → gmail_sync_state row with sender '_orders'
 *   seen-IDs store  → gmail_seen_messages (SHARED ledger with the bank pass;
 *                     sender sets don't overlap, and one ledger means no
 *                     email is ever fetched twice by either pass)
 *   filter-first    → Gmail query restricted to ORDER_QUERY_SENDERS
 *
 * After ingesting, runs the order→transaction matcher over all still-
 * unmatched orders (old unmatched orders retry on every run, so orders
 * that arrived before their bank email eventually link up).
 */

const CURSOR_KEY = "_orders";

// First-ever orders sync pulls 2 years. Order emails are ~10× more frequent
// than bank alerts; 2y is enough to enrich every txn KP actually looks at,
// and the SyncPanel backfill menu can widen it explicitly.
const FIRST_SYNC_LOOKBACK_DAYS = 365 * 2;

// Guarded stream writes — see the bank sync route for the full rationale. Once
// the client disconnects, enqueue()/close() throw ERR_INVALID_STATE ("failed
// to pipe response"), which masks the real error. Swallow so the live request
// can deliver its real payload and a torn-down stream never 500s.
function send(controller: ReadableStreamDefaultController, data: object) {
  try {
    controller.enqueue(new TextEncoder().encode(JSON.stringify(data) + "\n"));
  } catch {
    // Client gone / stream already closed — nothing to write to.
  }
}

function safeClose(controller: ReadableStreamDefaultController) {
  try {
    controller.close();
  } catch {
    // Already closed or errored (client aborted). Closing twice is a no-op.
  }
}

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return new Response(
      JSON.stringify({
        error: "missing_google_credentials",
        message: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env.local. Restart the dev server after adding them.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // Fail fast (and in plain English) if migration 011 hasn't been run —
  // otherwise every parsed order would silently fail to save.
  const { error: tableErr } = await supabase
    .from("orders")
    .select("id", { head: true, count: "exact" })
    .eq("user_id", user.id);
  if (isMissingTableError(tableErr)) {
    return new Response(
      JSON.stringify({
        error: "missing_orders_table",
        message: "The orders table doesn't exist yet. Run supabase/migrations/011_orders.sql in the Supabase SQL Editor, then sync again.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Migration 014 (review_status) gate — the sync now stamps every match with a
  // review state, so it must exist. Fail once, clearly, like the 011/013 gates.
  const { error: reviewColErr } = await supabase
    .from("orders")
    .select("review_status", { head: true, count: "exact" })
    .eq("user_id", user.id);
  if (isMissingColumnError(reviewColErr, "review_status")) {
    return new Response(
      JSON.stringify({
        error: "missing_review_status_column",
        message: "Run supabase/migrations/014_order_review_status.sql in the Supabase SQL Editor, then sync again — it adds the order-review queue.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
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

  const { data: cursorRow } = await supabase
    .from("gmail_sync_state")
    .select("last_internal_date, message_count")
    .eq("user_id", user.id)
    .eq("sender", CURSOR_KEY)
    .maybeSingle();

  const body = await req.json().catch(() => ({}));
  const backfillDays = typeof body?.lookback_days === "number" ? body.lookback_days : null;
  const isBackfill = backfillDays !== null;
  const isFirstSync = !isBackfill && !cursorRow?.last_internal_date;

  const afterSeconds = isBackfill
    ? Math.floor((Date.now() - backfillDays! * 86400 * 1000) / 1000)
    : isFirstSync
      ? Math.floor((Date.now() - FIRST_SYNC_LOOKBACK_DAYS * 86400 * 1000) / 1000)
      : Math.floor(cursorRow!.last_internal_date / 1000) + 1;

  // Discovery spans Gmail's Purchases category + order-ish subjects + the
  // marketplace senders, so ANY merchant's order confirmation is found — not
  // just the five hardcoded senders. Parsers stay strict downstream.
  const query = `(${ORDER_DISCOVERY_CLAUSES.join(" OR ")}) after:${afterSeconds}`;

  const auth = makeGmailOAuthClient();
  auth.setCredentials({ refresh_token: decrypt(settings.google_refresh_token_encrypted) });
  const gmail = google.gmail({ version: "v1", auth });

  // Same pagination discipline as the bank sync: Supabase caps selects at
  // 1000 rows, so drain explicitly or later IDs vanish from the dedupe set.
  const PAGE = 1000;
  async function loadAllIds(table: string): Promise<string[]> {
    const out: string[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from(table)
        .select("gmail_message_id")
        .eq("user_id", user!.id)
        .range(from, from + PAGE - 1);
      if (error) {
        console.error(`[gmail/orders] ${table} read error —`, error.message);
        break;
      }
      if (!data || data.length === 0) break;
      for (const r of data) if (r.gmail_message_id) out.push(r.gmail_message_id);
      if (data.length < PAGE) break;
    }
    return out;
  }

  const [seenIds, orderIds] = await Promise.all([
    loadAllIds("gmail_seen_messages"),
    loadAllIds("orders"),
  ]);
  const knownMsgIds = new Set<string>([...seenIds, ...orderIds]);

  const stream = new ReadableStream({
    async start(controller) {
      const result = {
        fetched: 0,
        new_orders: 0,
        matched: 0,
        pending_review: 0, // subset of `matched` that landed at medium/low → await KP's review
        skipped: 0,
        errors: [] as string[],
        is_first_sync: isFirstSync,
        is_backfill: isBackfill,
      };
      let maxInternalDate: number = cursorRow?.last_internal_date ?? 0;
      // Set once if the DB still has migration 011's five-source CHECK — so we
      // surface ONE actionable message instead of one error per D2C order.
      let sourceConstraintHit = false;

      try {
        send(controller, {
          status: "listing",
          message: isFirstSync
            ? "First order sync — scanning 2 years of order emails…"
            : "Checking for new order emails…",
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
          send(controller, {
            status: "listing",
            message: `Scanning order emails… ${allIds.length} found so far`,
          });
        } while (pageToken);

        const idsToFetch = allIds.filter((id) => !knownMsgIds.has(id));

        if (idsToFetch.length > 0) {
          send(controller, {
            status: "syncing",
            total: idsToFetch.length,
            message: `Found ${idsToFetch.length} new order email${idsToFetch.length === 1 ? "" : "s"}. Fetching…`,
          });

          const seenBatch: Array<{
            user_id: string;
            gmail_message_id: string;
            txn_id: null;
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
              console.error(`[gmail/orders] WARN: failed to record ${rows.length} seen IDs`, error.message);
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
                new_orders: result.new_orders,
              });
            }

            let lastSubject = "";
            let lastBody = "";
            let lastFrom = "";
            let lastInternalDate = 0;

            try {
              const full = await gmail.users.messages.get({ userId: "me", id: msgId, format: "full" });

              const msgInternalDate = parseInt(full.data.internalDate ?? "0", 10);
              if (msgInternalDate > maxInternalDate) maxInternalDate = msgInternalDate;
              lastInternalDate = msgInternalDate;

              const headers = full.data.payload?.headers || [];
              const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
              const fromHeader = headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
              const text = extractBody(full.data.payload);
              const html = extractHtml(full.data.payload);

              lastSubject = subject;
              lastBody = text;
              lastFrom = fromHeader;

              const parsed = parseOrderEmail(fromHeader, subject, text, html);

              if (!parsed) {
                result.skipped++;
              } else {
                const { error: upsertErr } = await supabase.from("orders").upsert(
                  {
                    user_id: user!.id,
                    source: parsed.source,
                    kind: parsed.kind,
                    gmail_message_id: msgId,
                    order_ref: parsed.order_ref ?? null,
                    merchant_name: parsed.merchant_name ?? null,
                    total_amount: parsed.total_amount ?? null,
                    order_at: new Date(msgInternalDate).toISOString(),
                    items: parsed.items,
                    raw_subject: subject,
                  },
                  { onConflict: "user_id,gmail_message_id" }
                );
                if (upsertErr) {
                  // 23514 = check_violation: source is still limited to the five
                  // marketplaces (migration 013 not run). Shopify/D2C orders
                  // can't save until it is — say so once, clearly.
                  if ((upsertErr as { code?: string }).code === "23514") {
                    if (!sourceConstraintHit) {
                      sourceConstraintHit = true;
                      result.errors.push(
                        "Run supabase/migrations/013_orders_any_source.sql — the orders table still rejects non-marketplace merchants (Shopify/D2C)."
                      );
                    }
                  } else {
                    result.errors.push(`order upsert ${msgId}: ${upsertErr.message}`);
                  }
                } else {
                  result.new_orders++;
                }
              }
            } catch (e) {
              result.errors.push(`fetch ${msgId}: ${(e as Error).message}`);
            }

            // ARCH-12: EVERY fetched ID is recorded — parsed, skipped, or
            // errored — so no order email is ever downloaded twice.
            seenBatch.push({
              user_id: user!.id,
              gmail_message_id: msgId,
              txn_id: null,
              raw_subject: lastSubject,
              raw_body: lastBody,
              raw_from: lastFrom,
              internal_date: lastInternalDate,
            });
            if (seenBatch.length >= 50) await flushSeenBatch();
          }

          await flushSeenBatch();
        }

        // ── Matching phase — runs even when zero new emails arrived, so
        // orders that predate their bank txn (or migration 011) link up. ──
        send(controller, { status: "matching", message: "Matching orders to transactions…" });

        const unmatched: Array<{
          id: string; source: string; kind: "order" | "refund";
          total_amount: string | number | null; order_at: string;
          merchant_name: string | null; items: unknown[] | null;
        }> = [];
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await supabase
            .from("orders")
            .select("id, source, kind, total_amount, order_at, merchant_name, items")
            .eq("user_id", user!.id)
            .is("txn_id", null)
            .eq("review_status", "unmatched") // skip 'rejected' dead-ends (reject = permanent unlink)
            .range(from, from + PAGE - 1);
          if (error || !data?.length) break;
          unmatched.push(...(data as typeof unmatched));
          if (data.length < PAGE) break;
        }

        // Merchant-first: the richest order (a merchant's own email, with items)
        // claims a transaction before a payment-gateway (Razorpay) confirmation
        // for the same charge — so the linked detail is the real item list, not
        // just an entity name. See orderMatchRank.
        unmatched.sort(
          (a, b) =>
            orderMatchRank({ source: b.source as OrderSource, itemsCount: b.items?.length ?? 0 }) -
            orderMatchRank({ source: a.source as OrderSource, itemsCount: a.items?.length ?? 0 })
        );

        const txns: TxnLite[] = [];
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await supabase
            .from("transactions")
            .select("id, amount_inr, txn_at, merchant, txn_type")
            .eq("user_id", user!.id)
            .range(from, from + PAGE - 1);
          if (error || !data?.length) break;
          for (const t of data) {
            // Supabase returns numeric columns as strings — coerce before math.
            txns.push({ ...t, amount_inr: Number(t.amount_inr) } as TxnLite);
          }
          if (data.length < PAGE) break;
        }

        const { data: claimedRows } = await supabase
          .from("orders")
          .select("txn_id")
          .eq("user_id", user!.id)
          .not("txn_id", "is", null);
        const usedTxnIds = new Set<string>((claimedRows ?? []).map((r) => r.txn_id as string));

        for (const o of unmatched) {
          const match = matchOrderToTxn(
            {
              source: o.source as OrderSource,
              kind: o.kind,
              total_amount: o.total_amount == null ? null : Number(o.total_amount),
              order_at: o.order_at,
              merchant_name: o.merchant_name,
            },
            txns,
            usedTxnIds
          );
          if (!match) continue;
          const { error: matchErr } = await supabase
            .from("orders")
            .update({
              txn_id: match.txnId,
              match_confidence: match.confidence satisfies MatchConfidence,
              // high → auto-confirmed; medium/low → pending KP's review (014).
              review_status: reviewStatusFor(match.confidence),
              matched_at: new Date().toISOString(),
            })
            .eq("id", o.id)
            .eq("user_id", user!.id);
          if (matchErr) {
            result.errors.push(`match save ${o.id}: ${matchErr.message}`);
          } else {
            usedTxnIds.add(match.txnId);
            result.matched++;
            if (reviewStatusFor(match.confidence) === "pending") result.pending_review++;
          }
        }

        // ── Advance the cursor (same contract as the bank sync). ──
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
            console.error("[gmail/orders] CRITICAL: cursor save failed — next sync restarts from the beginning!", cursorSaveErr.message);
            result.errors.push(`cursor save failed: ${cursorSaveErr.message}`);
          } else {
            await supabase.from("gmail_sync_ranges").insert({
              user_id: user!.id,
              sender: CURSOR_KEY,
              range_start: new Date(afterSeconds * 1000).toISOString().slice(0, 10),
              range_end: new Date().toISOString().slice(0, 10),
            });
          }
        }

        send(controller, { status: "done", ...result });
      } catch (e) {
        console.error("[gmail/orders] stream error:", (e as Error).message || e);
        send(controller, { status: "error", message: friendlyGmailSyncError(e) });
      } finally {
        safeClose(controller);
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
