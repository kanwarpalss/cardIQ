/**
 * Rebuild the complete Gyftr → voucher → merchant-order ledger from stored
 * email bodies and transactions. No Gmail calls.
 *
 * READ-ONLY by default. `--apply` reparses voucher/payment evidence, rematches
 * Gyftr purchase batches, transfers gateway claims for proven split payments,
 * clears legacy heuristic draws, and writes the evidence-backed result.
 */
import { readFileSync } from "fs";
import { join } from "path";
for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

import { createClient } from "@supabase/supabase-js";
import { parseGyftrVouchers } from "../src/lib/parsers/orders/gyftr";
import { parseOrderEmail, type OrderSource } from "../src/lib/parsers/orders/registry";
import { matchOrderToTxn, matchSplitOrderToTxn, reviewStatusFor, type TxnLite } from "../src/lib/order-match";
import { matchVoucherBatchToCharge } from "../src/lib/voucher-match";
import { compatibleVoucherKeys, normalizeBrand, reconcileVouchers, type VoucherPurchase, type VoucherPaidOrder } from "../src/lib/voucher-bridge";

const APPLY = process.argv.includes("--apply");
const PAGE = 1000;
const MARKETPLACE = new Set(["swiggy", "zomato", "bigbasket", "amazon", "blinkit"]);
const orderBrand = (o: { source: string; merchant_name: string | null }) =>
  normalizeBrand(MARKETPLACE.has(o.source) ? o.source : (o.merchant_name ?? o.source));

async function pages(s: any, table: string, columns: string): Promise<any[]> {
  const all: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await s.from(table).select(columns).range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data?.length) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return all;
}

async function main() {
  const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const [seen, txRows, initialOrders] = await Promise.all([
    pages(s, "gmail_seen_messages", "user_id, gmail_message_id, raw_subject, raw_body, raw_from, internal_date"),
    pages(s, "transactions", "id, user_id, amount_inr, txn_at, merchant, txn_type"),
    pages(s, "orders", "id, user_id, gmail_message_id, source, kind, merchant_name, total_amount, order_at, items, txn_id, match_confidence, review_status, duplicate_of, voucher_draws, card_paid_amount, voucher_paid_amount, voucher_brand_key, payment_evidence"),
  ]);
  const userId = initialOrders[0]?.user_id ?? seen[0]?.user_id;
  if (!userId) throw new Error("No user data found.");
  const txns: TxnLite[] = txRows.filter((t) => t.user_id === userId).map((t) => ({ ...t, amount_inr: Number(t.amount_inr) }));

  // 1) Reparse every Gyftr issuance, including legacy table/bulk formats.
  const parsedBatches = seen
    .filter((m) => m.user_id === userId && /@gyftr\.com/i.test(m.raw_from ?? ""))
    .map((m) => ({
      messageId: m.gmail_message_id,
      purchasedAt: new Date(Number(m.internal_date)).toISOString(),
      subject: m.raw_subject ?? "",
      vouchers: parseGyftrVouchers(m.raw_subject ?? "", m.raw_body ?? "", ""),
    }))
    .filter((b) => b.vouchers.length > 0)
    .sort((a, b) => a.purchasedAt.localeCompare(b.purchasedAt));

  if (APPLY) {
    const parsedRows = parsedBatches.flatMap((b) => b.vouchers.map((v) => ({
        user_id: userId, gmail_message_id: b.messageId, code: v.code ?? null,
        brand: v.brand, brand_key: normalizeBrand(v.brand), face_value: v.faceValue,
        purchased_at: b.purchasedAt, valid_till: v.validTill ?? null, raw_subject: b.subject,
      })));
    for (let i = 0; i < parsedRows.length; i += 200) {
      const { error } = await s.from("vouchers").upsert(parsedRows.slice(i, i + 200), { onConflict: "user_id,gmail_message_id,code" });
      if (error) throw new Error(`voucher upsert batch ${i}: ${error.message}`);
    }
  }

  let voucherRows = APPLY
    ? await pages(s, "vouchers", "id, user_id, gmail_message_id, code, brand_key, face_value, purchased_at, txn_id")
    : parsedBatches.flatMap((b) => b.vouchers.map((v) => ({
        id: `${b.messageId}:${v.code}`, user_id: userId, gmail_message_id: b.messageId,
        code: v.code, brand_key: normalizeBrand(v.brand), face_value: v.faceValue,
        purchased_at: b.purchasedAt, txn_id: null,
      })));
  voucherRows = voucherRows.filter((v) => v.user_id === userId);
  const parsedKeys = new Set(parsedBatches.flatMap((b) => b.vouchers.map((v) => `${b.messageId}\u0000${v.code ?? ""}`)));
  const staleMalformed = voucherRows.filter((v) =>
    /clickhere|redemptionsteps/i.test(v.brand_key ?? "") &&
    !parsedKeys.has(`${v.gmail_message_id}\u0000${v.code ?? ""}`)
  );
  if (APPLY && staleMalformed.length) {
    const { error } = await s.from("vouchers").delete().eq("user_id", userId).in("id", staleMalformed.map((v) => v.id));
    if (error) throw new Error(`stale malformed voucher cleanup: ${error.message}`);
    const staleIds = new Set(staleMalformed.map((v) => v.id));
    voucherRows = voucherRows.filter((v) => !staleIds.has(v.id));
  }
  const rowsByMessage = new Map<string, any[]>();
  for (const v of voucherRows) {
    const list = rowsByMessage.get(v.gmail_message_id) ?? [];
    list.push(v); rowsByMessage.set(v.gmail_message_id, list);
  }

  // Fresh batch plan. Transactions claimed by ordinary orders remain reserved;
  // Gyftr descriptors are reserved for vouchers by construction.
  const orderClaims = new Set(initialOrders.filter((o) => o.user_id === userId && o.txn_id).map((o) => o.txn_id as string));
  for (const t of txns) if (/gyftr/i.test(t.merchant ?? "")) orderClaims.delete(t.id);
  const used = new Set(orderClaims);
  let matchedBatches = 0, matchedVouchers = 0;
  const batchPlans: Array<{ messageId: string; batch: any[]; match: ReturnType<typeof matchVoucherBatchToCharge> }> = [];
  for (const [messageId, batch] of [...rowsByMessage].sort((a, b) => String(a[1][0].purchased_at).localeCompare(String(b[1][0].purchased_at)))) {
    const match = matchVoucherBatchToCharge({
      faceValue: batch.reduce((sum, v) => sum + Number(v.face_value), 0),
      purchasedAt: batch[0].purchased_at, voucherCount: batch.length,
    }, txns, used);
    for (const v of batch) v.txn_id = match?.txnId ?? null;
    if (match) { used.add(match.txnId); matchedBatches++; matchedVouchers += batch.length; }
    batchPlans.push({ messageId, batch, match });
  }
  if (APPLY) {
    for (let i = 0; i < batchPlans.length; i += 20) {
      await Promise.all(batchPlans.slice(i, i + 20).map(async ({ messageId, batch, match }) => {
        const { error } = await s.from("vouchers").update({
          txn_id: match?.txnId ?? null, match_confidence: match?.confidence ?? null,
          matched_at: match ? new Date().toISOString() : null,
        }).eq("user_id", userId).in("id", batch.map((v) => v.id));
        if (error) throw new Error(`voucher match ${messageId}: ${error.message}`);
      }));
    }
  }

  // 2) Reparse stored order bodies for explicit payment portions.
  const seenById = new Map(seen.filter((m) => m.user_id === userId).map((m) => [m.gmail_message_id, m]));
  const orders = initialOrders.filter((o) => o.user_id === userId).map((o) => ({ ...o }));
  let explicitSplits = 0;
  const paymentPatches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  for (const o of orders) {
    const mail = seenById.get(o.gmail_message_id);
    if (!mail) continue;
    const parsed = parseOrderEmail(mail.raw_from ?? "", mail.raw_subject ?? "", mail.raw_body ?? "", "");
    if (!parsed) continue;
    // A merchant email may omit payment methods entirely (Birkenstock). Keep a
    // previously proven inference unless the parser now has explicit evidence;
    // otherwise an idempotent rebuild would erase its own result.
    if (o.payment_evidence === "inferred_split" && parsed.voucher_paid_amount == null) continue;
    const before = JSON.stringify([
      Number(o.total_amount ?? 0), Number(o.card_paid_amount ?? 0), Number(o.voucher_paid_amount ?? 0),
      o.voucher_brand_key ?? null, o.payment_evidence ?? null,
    ]);
    o.total_amount = parsed.total_amount ?? o.total_amount;
    o.card_paid_amount = parsed.card_paid_amount ?? null;
    o.voucher_paid_amount = parsed.voucher_paid_amount ?? null;
    o.voucher_brand_key = parsed.voucher_brand ? normalizeBrand(parsed.voucher_brand) : null;
    o.payment_evidence = parsed.voucher_paid_amount != null ? "email" : null;
    if (o.voucher_paid_amount != null) explicitSplits++;
    const patch = {
        total_amount: o.total_amount, card_paid_amount: o.card_paid_amount,
        voucher_paid_amount: o.voucher_paid_amount, voucher_brand_key: o.voucher_brand_key,
        payment_evidence: o.payment_evidence,
      };
    const after = JSON.stringify([
      Number(o.total_amount ?? 0), Number(o.card_paid_amount ?? 0), Number(o.voucher_paid_amount ?? 0),
      o.voucher_brand_key ?? null, o.payment_evidence ?? null,
    ]);
    if (before !== after) paymentPatches.push({ id: o.id, patch });
  }
  if (APPLY) {
    for (let i = 0; i < paymentPatches.length; i += 20) {
      await Promise.all(paymentPatches.slice(i, i + 20).map(async ({ id, patch }) => {
        const { error } = await s.from("orders").update(patch).eq("id", id).eq("user_id", userId);
        if (error) throw new Error(`order payment reparse ${id}: ${error.message}`);
      }));
    }
  }

  const vps: VoucherPurchase[] = voucherRows.map((v) => ({
    id: v.id, brand: v.brand_key, faceValue: Number(v.face_value),
    purchasedAt: v.purchased_at, cardTxnId: v.txn_id,
  }));
  const gatewayClaims = new Map<string, string>();
  for (const o of orders) if (o.source === "razorpay" && o.txn_id) gatewayClaims.set(o.txn_id, o.id);
  const cardUsed = new Set<string>([
    ...vps.map((v) => v.cardTxnId).filter(Boolean) as string[],
    ...orders.filter((o) => o.txn_id && o.source !== "razorpay").map((o) => o.txn_id as string),
  ]);

  type Candidate = VoucherPaidOrder & { evidence: "email" | "inferred_split"; split?: ReturnType<typeof matchSplitOrderToTxn> };
  const candidates: Candidate[] = orders
    .filter((o) => o.kind === "order" && !o.duplicate_of && o.review_status !== "rejected" && Number(o.voucher_paid_amount) > 0)
    .map((o) => ({ id: o.id, brand: orderBrand(o), voucherBrand: o.voucher_brand_key,
      amount: Number(o.voucher_paid_amount), orderedAt: o.order_at,
      evidence: o.payment_evidence === "inferred_split" ? "inferred_split" : "email" }));

  // Explicit splits can claim their exact direct-card portion first.
  const cardUpdates = new Map<string, NonNullable<ReturnType<typeof matchSplitOrderToTxn>> | { txnId: string; confidence: "high" | "medium" | "low"; cardAmount: number; voucherAmount: number }>();
  for (const o of orders.filter((x) => x.kind === "order" && !x.txn_id && Number(x.card_paid_amount) > 0)) {
    const m = matchOrderToTxn({ source: o.source as OrderSource, kind: o.kind, total_amount: Number(o.total_amount),
      card_paid_amount: Number(o.card_paid_amount), order_at: o.order_at, merchant_name: o.merchant_name }, txns, cardUsed);
    if (!m) continue;
    cardUsed.add(m.txnId);
    cardUpdates.set(o.id, { ...m, cardAmount: Number(o.card_paid_amount), voucherAmount: Number(o.voucher_paid_amount ?? 0) });
  }

  // Infer only unique, affine, fully voucher-covered remainders.
  for (const o of orders.filter((x) => x.kind === "order" && !x.duplicate_of && x.review_status !== "rejected" &&
    x.voucher_paid_amount == null && x.total_amount != null && x.source !== "razorpay" && (x.items?.length ?? 0) > 0)
    .sort((a, b) => String(a.order_at).localeCompare(String(b.order_at)) || String(a.id).localeCompare(String(b.id)))) {
    const brand = orderBrand(o);
    const allowed = compatibleVoucherKeys(brand);
    const balance = (key: string) => vps.filter((v) => normalizeBrand(v.brand) === key &&
      new Date(v.purchasedAt).getTime() <= new Date(o.order_at).getTime() + 86_400_000).reduce((sum, v) => sum + v.faceValue, 0);
    const perOrderUsed = new Set(cardUsed);
    if (o.txn_id) perOrderUsed.delete(o.txn_id);
    const eligibleTxns = o.txn_id ? txns.filter((t) => t.id === o.txn_id) : txns;
    const split = matchSplitOrderToTxn({ source: o.source as OrderSource, kind: o.kind,
      total_amount: Number(o.total_amount), order_at: o.order_at, merchant_name: o.merchant_name },
      eligibleTxns, allowed.reduce((sum, key) => sum + balance(key), 0), perOrderUsed);
    if (!split) continue;
    const voucherBrand = allowed.find((key) => balance(key) + 0.75 >= split.voucherAmount);
    if (!voucherBrand) continue;
    cardUsed.add(split.txnId);
    cardUpdates.set(o.id, split);
    candidates.push({ id: o.id, brand, voucherBrand, amount: split.voucherAmount,
      orderedAt: o.order_at, evidence: "inferred_split", split });
  }

  const bridge = reconcileVouchers(vps, candidates);
  const candidateById = new Map(candidates.map((c) => [c.id, c]));
  const drawsByOrder = new Map<string, any[]>();
  let inferredSplits = 0;
  for (const attr of bridge.orders) {
    const c = candidateById.get(attr.orderId)!;
    if (c.split && attr.status !== "attributed") { cardUpdates.delete(c.id); continue; }
    if (!attr.draws.length) continue;
    drawsByOrder.set(c.id, attr.draws.map((d) => ({ ...d, evidence: c.evidence })));
    if (c.split) inferredSplits++;
  }

  if (APPLY) {
    for (const [orderId, m] of cardUpdates) {
      const c = candidateById.get(orderId);
      const { error } = await s.from("orders").update({
        txn_id: m.txnId, match_confidence: m.confidence, review_status: reviewStatusFor(m.confidence),
        matched_at: new Date().toISOString(), card_paid_amount: m.cardAmount,
        ...(c?.split ? { voucher_paid_amount: m.voucherAmount, voucher_brand_key: c.voucherBrand, payment_evidence: "inferred_split" } : {}),
      }).eq("id", orderId).eq("user_id", userId);
      if (error) throw new Error(`card/split update ${orderId}: ${error.message}`);
      const gatewayId = gatewayClaims.get(m.txnId);
      if (gatewayId) {
        const { error: releaseError } = await s.from("orders").update({
          txn_id: null, match_confidence: null, duplicate_of: orderId, review_status: "pending",
        }).eq("id", gatewayId).eq("user_id", userId);
        if (releaseError) throw new Error(`gateway release ${gatewayId}: ${releaseError.message}`);
      }
    }
    const { error: clearError } = await s.from("orders").update({ voucher_draws: [] }).eq("user_id", userId);
    if (clearError) throw new Error(`clear old draws: ${clearError.message}`);
    for (const [orderId, draws] of drawsByOrder) {
      const { error } = await s.from("orders").update({ voucher_draws: draws }).eq("id", orderId).eq("user_id", userId);
      if (error) throw new Error(`draw save ${orderId}: ${error.message}`);
    }
  }

  console.log(JSON.stringify({
    mode: APPLY ? "applied" : "dry-run",
    gyftrEmails: parsedBatches.length,
    vouchersParsed: parsedBatches.reduce((sum, b) => sum + b.vouchers.length, 0),
    voucherBatchesMatched: matchedBatches,
    vouchersMatched: matchedVouchers,
    explicitVoucherOrders: explicitSplits,
    inferredSplitOrders: inferredSplits,
    voucherAttributedOrders: drawsByOrder.size,
    voucherAttributedAmount: Math.round([...drawsByOrder.values()].flat().reduce((sum, d) => sum + Number(d.amount), 0) * 100) / 100,
    attributedOrders: bridge.orders.filter((a) => a.draws.length > 0).map((a) => {
      const o = orders.find((row) => row.id === a.orderId);
      const c = candidateById.get(a.orderId);
      return {
        merchant: o?.merchant_name ?? o?.source ?? "unknown",
        date: String(o?.order_at ?? "").slice(0, 10),
        voucherAmount: a.attributed,
        status: a.status,
        evidence: c?.evidence,
        directCardAmount: cardUpdates.get(a.orderId)?.cardAmount ?? (o?.card_paid_amount == null ? null : Number(o.card_paid_amount)),
      };
    }),
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
