import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/crypto";
import { google } from "googleapis";
import {
  makeGmailOAuthClient,
  extractBody,
  extractHtml,
} from "@/lib/gmail/extract";
import { friendlyGmailSyncError } from "@/lib/gmail/errors";
import { findPdfAttachments, parseOrderFromPdfs, decodeAttachmentData } from "@/lib/gmail/pdf";
import { isMissingTableError, isMissingColumnError } from "@/lib/supabase/errors";
import { parseOrderEmail, ORDER_DISCOVERY_CLAUSES, type OrderSource } from "@/lib/parsers/orders/registry";
import { parseGyftrVouchers, isGyftrSender } from "@/lib/parsers/orders/gyftr";
import { matchOrderToTxn, matchSplitOrderToTxn, orderMatchRank, reviewStatusFor, type TxnLite, type MatchConfidence } from "@/lib/order-match";
import { matchVoucherBatchToCharge } from "@/lib/voucher-match";
import { compatibleVoucherKeys, normalizeBrand, reconcileVouchers, type VoucherPurchase, type VoucherPaidOrder } from "@/lib/voucher-bridge";
import { planDedup, type DedupRow } from "@/lib/order-dedup";

// Marketplace sources reconcile against a voucher by their PLATFORM name (a
// Swiggy Money voucher funds swiggy-source orders whose merchant_name is the
// restaurant); D2C/other orders reconcile by their merchant name.
const MARKETPLACE_SOURCES = new Set<OrderSource>(["swiggy", "zomato", "bigbasket", "amazon", "blinkit"]);
function orderBrandKey(o: { source: string; merchant_name: string | null }): string {
  return normalizeBrand(MARKETPLACE_SOURCES.has(o.source as OrderSource) ? o.source : (o.merchant_name ?? o.source));
}

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

  // Migration 015 (vouchers) gate — the sync now stores Gyftr vouchers, so the
  // table must exist. Fail once, clearly, like the 011/013/014 gates.
  const { error: voucherTableErr } = await supabase
    .from("vouchers")
    .select("id", { head: true, count: "exact" })
    .eq("user_id", user.id);
  if (isMissingTableError(voucherTableErr)) {
    return new Response(
      JSON.stringify({
        error: "missing_vouchers_table",
        message: "Run supabase/migrations/015_vouchers.sql in the Supabase SQL Editor, then sync again — it adds the Gyftr voucher bridge.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const { error: splitColsErr } = await supabase
    .from("orders")
    .select("card_paid_amount, voucher_paid_amount, voucher_brand_key, payment_evidence", { head: true, count: "exact" })
    .eq("user_id", user.id);
  if (isMissingColumnError(splitColsErr, "card_paid_amount")) {
    return new Response(
      JSON.stringify({
        error: "missing_split_payment_columns",
        message: "Run supabase/migrations/017_split_voucher_payments.sql in the Supabase SQL Editor, then sync again.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Migration 016 (duplicate_of) gate — the sync flags same-purchase duplicates.
  const { error: dupColErr } = await supabase
    .from("orders")
    .select("duplicate_of", { head: true, count: "exact" })
    .eq("user_id", user.id);
  if (isMissingColumnError(dupColErr, "duplicate_of")) {
    return new Response(
      JSON.stringify({
        error: "missing_duplicate_of_column",
        message: "Run supabase/migrations/016_order_duplicates.sql in the Supabase SQL Editor, then sync again — it adds same-purchase de-duplication.",
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
        new_vouchers: 0,      // Gyftr vouchers parsed + stored this run
        vouchers_matched: 0,  // vouchers linked to their funding GYFTR charge
        voucher_linked: 0,    // orders with an evidence-backed voucher drawdown
        duplicates_flagged: 0, // same-purchase duplicate orders flagged for review
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

              // Gyftr emails are voucher ISSUANCES, not orders — route them to
              // the vouchers table and skip the order pipeline entirely.
              if (isGyftrSender(fromHeader)) {
                const vouchers = parseGyftrVouchers(subject, text, html);
                if (vouchers.length === 0) {
                  result.skipped++;
                } else {
                  const rows = vouchers.map((vch) => ({
                    user_id: user!.id,
                    gmail_message_id: msgId,
                    code: vch.code ?? null,
                    brand: vch.brand,
                    brand_key: normalizeBrand(vch.brand),
                    face_value: vch.faceValue,
                    purchased_at: new Date(msgInternalDate).toISOString(),
                    valid_till: vch.validTill ?? null,
                    raw_subject: subject,
                  }));
                  const { error: vErr } = await supabase
                    .from("vouchers")
                    .upsert(rows, { onConflict: "user_id,gmail_message_id,code" });
                  if (vErr) {
                    result.errors.push(`voucher upsert ${msgId}: ${vErr.message}`);
                  } else {
                    result.new_vouchers += rows.length;
                  }
                }
                // Record as seen and move to the next email (skip order parse).
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
                continue;
              }

              let parsed = parseOrderEmail(fromHeader, subject, text, html);

              // PDF-attachment fallback (cost-gated): only when the body yielded
              // NO items and the message actually carries a PDF. Merchants like
              // IKEA ship every line item in a PDF invoice, never the body.
              if ((parsed?.items.length ?? 0) === 0) {
                const pdfs = findPdfAttachments(full.data.payload);
                if (pdfs.length > 0) {
                  const download = async (attachmentId: string) => {
                    const att = await gmail.users.messages.attachments.get({
                      userId: "me", messageId: msgId, id: attachmentId,
                    });
                    return decodeAttachmentData(att.data.data);
                  };
                  const fromPdf = await parseOrderFromPdfs(fromHeader, pdfs, download);
                  if (fromPdf && fromPdf.items.length > 0) parsed = fromPdf;
                }
              }

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
                    card_paid_amount: parsed.card_paid_amount ?? null,
                    voucher_paid_amount: parsed.voucher_paid_amount ?? null,
                    voucher_brand_key: parsed.voucher_brand ? normalizeBrand(parsed.voucher_brand) : null,
                    payment_evidence: parsed.voucher_paid_amount != null ? "email" : null,
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
          card_paid_amount: string | number | null;
        }> = [];
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await supabase
            .from("orders")
            .select("id, source, kind, total_amount, card_paid_amount, order_at, merchant_name, items")
            .eq("user_id", user!.id)
            .is("txn_id", null)
            .is("duplicate_of", null)          // a flagged duplicate is matched via its primary, not on its own
            .neq("review_status", "rejected")  // 'rejected' = permanent unlink (a human dead-end). Everything
            .range(from, from + PAGE - 1);      // else without a txn (incl. legit 'pending') is retried each run
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

        // Txns already claimed — by an order OR a voucher — so nothing is
        // attributed twice across the two matchers.
        const [{ data: claimedOrderRows }, { data: claimedVoucherRows }] = await Promise.all([
          supabase.from("orders").select("id, txn_id, source").eq("user_id", user!.id).not("txn_id", "is", null),
          supabase.from("vouchers").select("txn_id").eq("user_id", user!.id).not("txn_id", "is", null),
        ]);
        const usedTxnIds = new Set<string>([
          ...(claimedOrderRows ?? []).map((r) => r.txn_id as string),
          ...(claimedVoucherRows ?? []).map((r) => r.txn_id as string),
        ]);
        const gatewayClaimByTxn = new Map<string, string>();
        for (const row of claimedOrderRows ?? []) {
          if (row.source === "razorpay" && row.txn_id) gatewayClaimByTxn.set(row.txn_id as string, row.id as string);
        }

        // ── Voucher → funding GYFTR charge. Runs FIRST so a distinctive "GYFTR
        // VIA SMARTBUY" charge is reserved by its voucher before order matching
        // (which could otherwise coincidentally amount-match it). ──
        const unmatchedVouchers: Array<{
          id: string; gmail_message_id: string; face_value: string | number;
          purchased_at: string; txn_id: string | null;
        }> = [];
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await supabase
            .from("vouchers")
            .select("id, gmail_message_id, face_value, purchased_at, txn_id")
            .eq("user_id", user!.id)
            .order("purchased_at", { ascending: true })
            .range(from, from + PAGE - 1);
          if (error || !data?.length) break;
          unmatchedVouchers.push(...(data as typeof unmatchedVouchers));
          if (data.length < PAGE) break;
        }
        const voucherBatches = new Map<string, typeof unmatchedVouchers>();
        for (const vch of unmatchedVouchers) {
          const batch = voucherBatches.get(vch.gmail_message_id) ?? [];
          batch.push(vch);
          voucherBatches.set(vch.gmail_message_id, batch);
        }
        for (const batch of voucherBatches.values()) {
          const existing = [...new Set(batch.map((v) => v.txn_id).filter(Boolean) as string[])];
          if (existing.length === 1 && batch.every((v) => v.txn_id === existing[0])) continue;
          const batchUsed = new Set(usedTxnIds);
          for (const id of existing) batchUsed.delete(id);
          const vmatch = matchVoucherBatchToCharge(
            {
              faceValue: batch.reduce((sum, v) => sum + Number(v.face_value), 0),
              purchasedAt: batch[0].purchased_at,
              voucherCount: batch.length,
            },
            txns,
            batchUsed
          );
          if (!vmatch) continue;
          const { error: vmErr } = await supabase
            .from("vouchers")
            .update({
              txn_id: vmatch.txnId,
              match_confidence: vmatch.confidence satisfies MatchConfidence,
              matched_at: new Date().toISOString(),
            })
            .in("id", batch.map((v) => v.id))
            .eq("user_id", user!.id);
          if (vmErr) {
            result.errors.push(`voucher batch match save ${batch[0].gmail_message_id}: ${vmErr.message}`);
          } else {
            for (const id of existing) usedTxnIds.delete(id);
            usedTxnIds.add(vmatch.txnId);
            result.vouchers_matched += batch.length;
          }
        }

        for (const o of unmatched) {
          const match = matchOrderToTxn(
            {
              source: o.source as OrderSource,
              kind: o.kind,
              total_amount: o.total_amount == null ? null : Number(o.total_amount),
              card_paid_amount: o.card_paid_amount == null ? null : Number(o.card_paid_amount),
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

        // ── Same-purchase de-duplication. One purchase emits several order
        // emails (merchant + payment gateway + shipper), each a row. Cluster by
        // amount + same time, keep the richest as primary, flag the rest. ──
        await runDedup();

        // Evidence-backed voucher reconciliation runs after ordinary dedup so
        // a gateway row released by a split transfer is not immediately
        // unflagged by the amount-based deduper.
        await runVoucherDrawdown(gatewayClaimByTxn);

        async function runDedup() {
          type Row = {
            id: string; source: string; items: unknown[] | null; total_amount: string | number | null;
            order_at: string; txn_id: string | null; review_status: string; duplicate_of: string | null;
            match_confidence: string | null; order_ref: string | null; merchant_name: string | null;
          };
          const rows: Row[] = [];
          for (let from = 0; ; from += PAGE) {
            const { data, error } = await supabase
              .from("orders")
              .select("id, source, items, total_amount, order_at, txn_id, review_status, duplicate_of, match_confidence, order_ref, merchant_name")
              .eq("user_id", user!.id)
              .range(from, from + PAGE - 1);
            if (error || !data?.length) break;
            rows.push(...(data as Row[]));
            if (data.length < PAGE) break;
          }
          // Plan the corrections with the shared planner (one source of truth for
          // the Invariant-#6 rules — same code the heal script uses), then apply.
          const planRows: DedupRow[] = rows.map((r) => ({
            id: r.id, source: r.source as OrderSource, itemsCount: Array.isArray(r.items) ? r.items.length : 0,
            total_amount: r.total_amount == null ? null : Number(r.total_amount), order_at: r.order_at, txn_id: r.txn_id,
            order_ref: r.order_ref, merchantKey: orderBrandKey(r),
            review_status: r.review_status, match_confidence: r.match_confidence, duplicate_of: r.duplicate_of,
          }));
          for (const a of planDedup(planRows)) {
            if (a.kind === "transfer") {
              const { error } = await supabase.from("orders").update({
                txn_id: a.txnId, match_confidence: a.matchConfidence,
                review_status: a.reviewStatus, matched_at: new Date().toISOString(), duplicate_of: null,
              }).eq("id", a.primaryId).eq("user_id", user!.id);
              if (error) result.errors.push(`dedup txn-transfer ${a.primaryId}: ${error.message}`);
            } else if (a.kind === "unflag") {
              const { error } = await supabase.from("orders").update({ duplicate_of: null })
                .eq("id", a.id).eq("user_id", user!.id);
              if (error) result.errors.push(`dedup unflag ${a.id}: ${error.message}`);
            } else {
              const { error } = await supabase.from("orders").update({
                duplicate_of: a.primaryId, review_status: "pending",
                ...(a.releaseTxn ? { txn_id: null, match_confidence: null } : {}),
              }).eq("id", a.id).eq("user_id", user!.id);
              if (error) result.errors.push(`dedup flag ${a.id}: ${error.message}`);
              else result.duplicates_flagged++;
            }
          }
        }

        async function runVoucherDrawdown(gatewayClaims: ReadonlyMap<string, string>) {
          const voucherRows: Array<{ id: string; brand_key: string; face_value: string | number; purchased_at: string; txn_id: string | null }> = [];
          for (let from = 0; ; from += PAGE) {
            const { data, error } = await supabase
              .from("vouchers")
              .select("id, brand_key, face_value, purchased_at, txn_id")
              .eq("user_id", user!.id)
              .range(from, from + PAGE - 1);
            if (error || !data?.length) break;
            voucherRows.push(...(data as typeof voucherRows));
            if (data.length < PAGE) break;
          }
          if (voucherRows.length === 0) return;

          const vps: VoucherPurchase[] = voucherRows.map((v) => ({
            id: v.id, brand: v.brand_key, faceValue: Number(v.face_value),
            purchasedAt: v.purchased_at, cardTxnId: v.txn_id,
          }));
          type VoucherOrderRow = {
            id: string; source: string; kind: "order" | "refund"; merchant_name: string | null;
            total_amount: string | number | null; card_paid_amount: string | number | null;
            voucher_paid_amount: string | number | null; voucher_brand_key: string | null;
            payment_evidence: "email" | "inferred_split" | null; order_at: string;
            txn_id: string | null; review_status: string; duplicate_of: string | null;
            items: unknown[] | null; voucher_draws: unknown[] | null;
          };
          const allOrders: VoucherOrderRow[] = [];
          for (let from = 0; ; from += PAGE) {
            const { data, error } = await supabase.from("orders")
              .select("id, source, kind, merchant_name, total_amount, card_paid_amount, voucher_paid_amount, voucher_brand_key, payment_evidence, order_at, txn_id, review_status, duplicate_of, items, voucher_draws")
              .eq("user_id", user!.id).range(from, from + PAGE - 1);
            if (error || !data?.length) break;
            allOrders.push(...(data as VoucherOrderRow[]));
            if (data.length < PAGE) break;
          }

          type Candidate = VoucherPaidOrder & { evidence: "email" | "inferred_split"; split?: ReturnType<typeof matchSplitOrderToTxn> };
          const candidates: Candidate[] = allOrders
            .filter((o) => o.kind === "order" && !o.duplicate_of && o.review_status !== "rejected" && o.voucher_paid_amount != null && Number(o.voucher_paid_amount) > 0)
            .map((o) => ({
              id: o.id, brand: orderBrandKey(o), voucherBrand: o.voucher_brand_key,
              amount: Number(o.voucher_paid_amount), orderedAt: o.order_at,
              evidence: o.payment_evidence === "inferred_split" ? "inferred_split" : "email",
            }));

          // Gateway-confirmation rows are weak evidence and may relinquish their
          // transaction to a richer merchant order that proves a voucher split.
          const splitUsed = new Set(usedTxnIds);
          for (const txnId of gatewayClaims.keys()) splitUsed.delete(txnId);
          const splitRows = allOrders
            .filter((o) => o.kind === "order" && !o.txn_id && !o.duplicate_of && o.review_status !== "rejected" &&
              o.voucher_paid_amount == null && o.total_amount != null && o.source !== "razorpay" && (o.items?.length ?? 0) > 0)
            .sort((a, b) => new Date(a.order_at).getTime() - new Date(b.order_at).getTime() || a.id.localeCompare(b.id));

          for (const o of splitRows) {
            const brand = orderBrandKey(o);
            const allowed = compatibleVoucherKeys(brand);
            const eligibleBalance = (key: string) => vps
              .filter((v) => normalizeBrand(v.brand) === key && new Date(v.purchasedAt).getTime() <= new Date(o.order_at).getTime() + 86_400_000)
              .reduce((sum, v) => sum + v.faceValue, 0);
            const available = allowed.reduce((sum, key) => sum + eligibleBalance(key), 0);
            const split = matchSplitOrderToTxn({
              source: o.source as OrderSource, kind: o.kind,
              total_amount: Number(o.total_amount), order_at: o.order_at, merchant_name: o.merchant_name,
            }, txns, available, splitUsed);
            if (!split) continue;
            const voucherBrand = allowed.find((key) => eligibleBalance(key) + 0.75 >= split.voucherAmount);
            if (!voucherBrand) continue;
            candidates.push({
              id: o.id, brand, voucherBrand, amount: split.voucherAmount,
              orderedAt: o.order_at, evidence: "inferred_split", split,
            });
            splitUsed.add(split.txnId);
          }

          const bridge = reconcileVouchers(vps, candidates);
          const candidateById = new Map(candidates.map((o) => [o.id, o]));
          const drawsByOrder = new Map<string, Array<Record<string, unknown>>>();
          for (const attr of bridge.orders) {
            const candidate = candidateById.get(attr.orderId)!;
            // An inferred split is accepted only when voucher balance covers
            // the exact remainder. Explicit email evidence may remain partial.
            if (candidate.split && attr.status !== "attributed") continue;
            if (attr.draws.length === 0) continue;
            drawsByOrder.set(attr.orderId, attr.draws.map((d) => ({ ...d, evidence: candidate.evidence })));

            if (candidate.split) {
              const gatewayOrderId = gatewayClaims.get(candidate.split.txnId);
              const { error: splitErr } = await supabase.from("orders").update({
                txn_id: candidate.split.txnId,
                match_confidence: candidate.split.confidence,
                review_status: reviewStatusFor(candidate.split.confidence),
                matched_at: new Date().toISOString(),
                card_paid_amount: candidate.split.cardAmount,
                voucher_paid_amount: candidate.split.voucherAmount,
                voucher_brand_key: candidate.voucherBrand,
                payment_evidence: "inferred_split",
              }).eq("id", candidate.id).eq("user_id", user!.id);
              if (splitErr) {
                result.errors.push(`split payment save ${candidate.id}: ${splitErr.message}`);
                drawsByOrder.delete(attr.orderId);
                continue;
              }
              if (gatewayOrderId) {
                const { error: releaseErr } = await supabase.from("orders").update({
                  txn_id: null, match_confidence: null, duplicate_of: candidate.id, review_status: "pending",
                }).eq("id", gatewayOrderId).eq("user_id", user!.id);
                if (releaseErr) result.errors.push(`split gateway release ${gatewayOrderId}: ${releaseErr.message}`);
              }
            }
          }

          // Clear stale heuristic draws from the old implementation, then write
          // only evidence-backed attributions from this complete recomputation.
          const staleIds = allOrders
            .filter((o) => Array.isArray(o.voucher_draws) && o.voucher_draws.length > 0 && !drawsByOrder.has(o.id))
            .map((o) => o.id);
          for (let i = 0; i < staleIds.length; i += 100) {
            const { error } = await supabase.from("orders").update({ voucher_draws: [] })
              .eq("user_id", user!.id).in("id", staleIds.slice(i, i + 100));
            if (error) result.errors.push(`voucher stale-draw clear: ${error.message}`);
          }
          for (const [orderId, draws] of drawsByOrder) {
            const { error: dErr } = await supabase.from("orders").update({ voucher_draws: draws })
              .eq("id", orderId).eq("user_id", user!.id);
            if (dErr) result.errors.push(`voucher draw save ${orderId}: ${dErr.message}`);
            else result.voucher_linked++;
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
