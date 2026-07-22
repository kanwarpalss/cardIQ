/**
 * sync-orders-offline.ts — run the Orders sync's MATCH + DEDUP phases without a
 * Gmail fetch. Use after a bulk import (import-amazon / import-blinkit) to link
 * the new orders to card charges and flag same-purchase duplicates, without
 * needing the app running or an OAuth session.
 *
 * It deliberately reuses the SAME shared logic the live sync route uses —
 * matchOrderToTxn (order→charge) and planDedup (Invariant #6 reconciliation,
 * ARCH-04's single source of truth) — so behaviour cannot drift from production.
 *
 * It SKIPS the two voucher phases (voucher→charge batch match, evidence-backed
 * drawdown). The voucher ledger is already reconciled (migration 017); bulk
 * imports are never voucher-funded, and vouchers that already hold a txn_id are
 * carried into usedTxnIds so order matching can't steal a voucher's charge.
 *
 * READ-ONLY by default. Run:  npx tsx scripts/sync-orders-offline.ts [--apply]
 */
import { readFileSync } from "fs";
import { join } from "path";
for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { createClient } from "@supabase/supabase-js";
import { matchOrderToTxn, reviewStatusFor, orderMatchRank, type TxnLite, type MatchConfidence } from "../src/lib/order-match";
import { planDedup, type DedupRow } from "../src/lib/order-dedup";
import { normalizeBrand } from "../src/lib/voucher-bridge";
import type { OrderSource } from "../src/lib/parsers/orders/types";

const APPLY = process.argv.includes("--apply");
const PAGE = 1000;

// Same brand-key rule as the sync route: marketplaces reconcile by platform,
// D2C/other by merchant name.
const MARKETPLACE_SOURCES = new Set<OrderSource>(["swiggy", "zomato", "bigbasket", "amazon", "blinkit"]);
const orderBrandKey = (o: { source: string; merchant_name: string | null }): string =>
  normalizeBrand(MARKETPLACE_SOURCES.has(o.source as OrderSource) ? o.source : (o.merchant_name ?? o.source));

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: s } = await sb.from("user_settings").select("user_id").limit(1).single();
  const uid = s!.user_id as string;

  const loadAll = async (cols: string, filter?: (q: any) => any) => {
    const out: any[] = [];
    for (let from = 0; ; from += PAGE) {
      let q = sb.from("orders").select(cols).eq("user_id", uid).range(from, from + PAGE - 1);
      if (filter) q = filter(q);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      if (!data?.length) break;
      out.push(...data);
      if (data.length < PAGE) break;
    }
    return out;
  };

  // ── MATCH: unmatched, non-duplicate, non-rejected orders → card charges. ──
  const unmatched = await loadAll(
    "id, source, kind, total_amount, card_paid_amount, order_at, merchant_name, items",
    (q) => q.is("txn_id", null).is("duplicate_of", null).neq("review_status", "rejected")
  );
  // Merchant-first: richest order claims a charge before a gateway sibling.
  unmatched.sort(
    (a, b) =>
      orderMatchRank({ source: b.source as OrderSource, itemsCount: b.items?.length ?? 0 }) -
      orderMatchRank({ source: a.source as OrderSource, itemsCount: a.items?.length ?? 0 })
  );

  const txns: TxnLite[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data } = await sb.from("transactions").select("id, amount_inr, txn_at, merchant, txn_type").eq("user_id", uid).range(from, from + PAGE - 1);
    if (!data?.length) break;
    for (const t of data) txns.push({ ...t, amount_inr: Number(t.amount_inr) } as TxnLite);
    if (data.length < PAGE) break;
  }

  // Charges already claimed by an order OR a voucher — never attribute twice.
  const [{ data: claimedOrders }, { data: claimedVouchers }] = await Promise.all([
    sb.from("orders").select("txn_id").eq("user_id", uid).not("txn_id", "is", null),
    sb.from("vouchers").select("txn_id").eq("user_id", uid).not("txn_id", "is", null),
  ]);
  const usedTxnIds = new Set<string>([
    ...(claimedOrders ?? []).map((r) => r.txn_id as string),
    ...(claimedVouchers ?? []).map((r) => r.txn_id as string),
  ]);

  let matched = 0, pending = 0;
  const byConf: Record<string, number> = {};
  for (const o of unmatched) {
    const match = matchOrderToTxn(
      {
        source: o.source as OrderSource, kind: o.kind,
        total_amount: o.total_amount == null ? null : Number(o.total_amount),
        card_paid_amount: o.card_paid_amount == null ? null : Number(o.card_paid_amount),
        order_at: o.order_at, merchant_name: o.merchant_name,
      },
      txns, usedTxnIds
    );
    if (!match) continue;
    byConf[match.confidence] = (byConf[match.confidence] ?? 0) + 1;
    matched++;
    if (reviewStatusFor(match.confidence) === "pending") pending++;
    usedTxnIds.add(match.txnId);
    if (APPLY) {
      const { error } = await sb.from("orders").update({
        txn_id: match.txnId, match_confidence: match.confidence satisfies MatchConfidence,
        review_status: reviewStatusFor(match.confidence), matched_at: new Date().toISOString(),
      }).eq("id", o.id).eq("user_id", uid);
      if (error) console.error("  match save error", o.id, error.message);
    }
  }
  console.log(`MATCH: ${matched} of ${unmatched.length} unmatched orders link to a charge (${JSON.stringify(byConf)}; ${pending} land as pending review).`);

  // ── DEDUP: cluster same-purchase rows, flag the non-primary via planDedup. ──
  const allRows = await loadAll("id, source, items, total_amount, order_at, txn_id, review_status, duplicate_of, match_confidence, order_ref, merchant_name");
  const planRows: DedupRow[] = allRows.map((r) => ({
    id: r.id, source: r.source as OrderSource, itemsCount: Array.isArray(r.items) ? r.items.length : 0,
    total_amount: r.total_amount == null ? null : Number(r.total_amount), order_at: r.order_at, txn_id: r.txn_id,
    order_ref: r.order_ref, merchantKey: orderBrandKey(r),
    review_status: r.review_status, match_confidence: r.match_confidence, duplicate_of: r.duplicate_of,
  }));
  const actions = planDedup(planRows);
  const counts = { transfer: 0, unflag: 0, flag: 0 };
  for (const a of actions) counts[a.kind]++;
  console.log(`DEDUP: ${actions.length} actions — ${counts.flag} flag-as-duplicate, ${counts.transfer} charge-transfer, ${counts.unflag} unflag.`);

  if (APPLY) {
    for (const a of actions) {
      if (a.kind === "transfer") {
        await sb.from("orders").update({ txn_id: a.txnId, match_confidence: a.matchConfidence, review_status: a.reviewStatus, matched_at: new Date().toISOString(), duplicate_of: null }).eq("id", a.primaryId).eq("user_id", uid);
      } else if (a.kind === "unflag") {
        await sb.from("orders").update({ duplicate_of: null }).eq("id", a.id).eq("user_id", uid);
      } else {
        await sb.from("orders").update({ duplicate_of: a.primaryId, review_status: "pending", ...(a.releaseTxn ? { txn_id: null, match_confidence: null } : {}) }).eq("id", a.id).eq("user_id", uid);
      }
    }
  }
  console.log(APPLY ? "\nAPPLIED." : "\n(dry run — nothing written. Re-run with --apply.)");
}
main().catch((e) => { console.error(e); process.exit(1); });
