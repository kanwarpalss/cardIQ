/**
 * order-match-audit.ts — READ-ONLY 2-year audit of payment ↔ order matching.
 *
 * Answers: of all card PAYMENTS (debit transactions), how many can we marry to
 * the MERCHANT's order email (with item detail), and what's missing?
 *
 * Reuses the app's REAL code (decrypt, Gmail extractor, order parsers, matcher,
 * merchant-first ranking) so the numbers equal what the live orders-sync
 * produces. Writes NOTHING to the DB or Gmail — only reads, and emits a local
 * JSON (audit-review.json) that feeds the HTML review widget.
 *
 * Run:  npx tsx scripts/order-match-audit.ts
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import { decrypt } from "../src/lib/crypto";
import { makeGmailOAuthClient, extractBody, extractHtml } from "../src/lib/gmail/extract";
import { parseOrderEmail, ORDER_DISCOVERY_CLAUSES } from "../src/lib/parsers/orders/registry";
import { matchOrderToTxn, orderMatchRank, type TxnLite, type OrderLite } from "../src/lib/order-match";
import type { OrderItem } from "../src/lib/parsers/orders/types";

const INR = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
const pct = (a: number, b: number) => (b === 0 ? "0.0" : ((a / b) * 100).toFixed(1));
const YEARS = 2;
const afterTs = Math.floor((Date.now() - YEARS * 365 * 86400 * 1000) / 1000);
const gapLabel = (a: string, b: string) => {
  const min = Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 60000;
  return min < 90 ? `${Math.round(min)} min` : `${(min / 1440).toFixed(1)} days`;
};

type Txn = TxnLite & { card_last4: string; original_currency: string | null };
type Parsed = {
  source: string; kind: "order" | "refund"; total_amount: number | null;
  order_at: string; merchant_name: string | null; order_ref?: string;
  items: OrderItem[]; subject: string; sender: string;
};

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const { data: settings } = await supabase
    .from("user_settings")
    .select("user_id, google_refresh_token_encrypted")
    .not("google_refresh_token_encrypted", "is", null)
    .limit(1)
    .maybeSingle();
  if (!settings?.google_refresh_token_encrypted) throw new Error("No user with a Gmail refresh token found.");
  const userId = settings.user_id as string;

  // ── Payment universe ────────────────────────────────────────────────────────
  const txns: Txn[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("transactions")
      .select("id, amount_inr, txn_at, merchant, txn_type, card_last4, original_currency")
      .eq("user_id", userId).order("txn_at", { ascending: false }).range(from, from + 999);
    if (error) throw error;
    if (!data?.length) break;
    for (const t of data) txns.push({ ...t, amount_inr: Number(t.amount_inr) } as Txn);
    if (data.length < 1000) break;
  }
  const inrOnly = (t: Txn) => !t.original_currency || t.original_currency.toUpperCase() === "INR";
  const debits2y = txns.filter((t) => t.txn_type === "debit" && inrOnly(t) && new Date(t.txn_at).getTime() >= afterTs * 1000);
  const txnById = new Map(txns.map((t) => [t.id, t]));
  console.log("── Payment universe ──");
  console.log(`  ${txns.length} txns total · ${debits2y.length} INR debits in last ${YEARS}y`);

  // ── Order universe ──────────────────────────────────────────────────────────
  const auth = makeGmailOAuthClient();
  auth.setCredentials({ refresh_token: decrypt(settings.google_refresh_token_encrypted) });
  const gmail = google.gmail({ version: "v1", auth });
  const query = `(${ORDER_DISCOVERY_CLAUSES.join(" OR ")}) after:${afterTs}`;

  console.log("\n── Scanning Gmail (2y) ──");
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({ userId: "me", q: query, maxResults: 500, pageToken });
    for (const m of res.data.messages || []) if (m.id) ids.push(m.id);
    pageToken = res.data.nextPageToken ?? undefined;
    process.stderr.write(`\r  listed ${ids.length}…`);
  } while (pageToken);
  console.log(`\n  ${ids.length} candidate emails.`);

  const orders: Parsed[] = [];
  const bySource: Record<string, number> = {};
  let skipped = 0;
  for (let i = 0; i < ids.length; i++) {
    try {
      const full = await gmail.users.messages.get({ userId: "me", id: ids[i], format: "full" });
      const H = full.data.payload?.headers || [];
      const subject = H.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
      const sender = H.find((h) => h.name?.toLowerCase() === "from")?.value || "";
      const p = parseOrderEmail(sender, subject, extractBody(full.data.payload), extractHtml(full.data.payload));
      if (!p) { skipped++; continue; }
      bySource[p.source] = (bySource[p.source] || 0) + 1;
      orders.push({
        source: p.source, kind: p.kind, total_amount: p.total_amount ?? null,
        order_at: new Date(parseInt(full.data.internalDate ?? "0", 10)).toISOString(),
        merchant_name: p.merchant_name ?? null, order_ref: p.order_ref,
        items: p.items, subject, sender,
      });
    } catch { skipped++; }
    if (i % 50 === 0) process.stderr.write(`\r  inspected ${i}/${ids.length} (parsed ${orders.length})…`);
  }
  console.log(`\n  parsed ${orders.length} orders, skipped ${skipped} non-orders.`);
  console.log("  by source:", Object.entries(bySource).map(([s, n]) => `${s}=${n}`).join("  "));

  // ── Match: merchant-first (real orderMatchRank), item-rich claims first ──────
  const used = new Set<string>();
  type Row = { confidence: string; gap: string; order: Parsed; txn: Txn };
  const rows: Row[] = [];
  const conf: Record<string, number> = { high: 0, medium: 0, low: 0 };
  const ranked = [...orders].sort(
    (a, b) => orderMatchRank({ source: b.source as any, itemsCount: b.items.length }) -
              orderMatchRank({ source: a.source as any, itemsCount: a.items.length })
  );
  for (const o of ranked) {
    const m = matchOrderToTxn(o as unknown as OrderLite, txns, used);
    if (!m) continue;
    used.add(m.txnId);
    conf[m.confidence]++;
    const t = txnById.get(m.txnId)!;
    rows.push({ confidence: m.confidence, gap: gapLabel(o.order_at, t.txn_at), order: o, txn: t });
  }
  const matchedTxnIds = new Set(rows.map((r) => r.txn.id));
  const withItems = rows.filter((r) => r.order.items.length > 0);

  // ── Report ──────────────────────────────────────────────────────────────────
  const coveredDebits = debits2y.filter((t) => matchedTxnIds.has(t.id));
  console.log("\n════════ RESULTS (last " + YEARS + "y) ════════");
  console.log(`Orders matched:        ${rows.length}   (high=${conf.high} medium=${conf.medium} low=${conf.low})`);
  console.log(`  with real item detail: ${withItems.length}`);
  console.log(`\nPAYMENT COVERAGE (INR debits):`);
  console.log(`  matched to an order : ${coveredDebits.length} / ${debits2y.length}  (${pct(coveredDebits.length, debits2y.length)}%)`);
  console.log(`  auto-confident (high): ${rows.filter((r) => r.confidence === "high").length}`);
  console.log(`  NEEDS REVIEW (med/low): ${conf.medium + conf.low}   → audit-review.json → widget`);

  const unmatched = debits2y.filter((t) => !matchedTxnIds.has(t.id)).sort((a, b) => b.amount_inr - a.amount_inr);
  console.log(`\nTop 15 UNMATCHED payments (offline swipes OR real gaps):`);
  for (const t of unmatched.slice(0, 15))
    console.log(`  ${t.txn_at.slice(0,10)}  ${INR(t.amount_inr).padStart(11)}  ${(t.merchant||"(none)").slice(0,40)}`);

  // ── Emit review data for the widget (uncertain matches first) ───────────────
  const review = rows
    .sort((a, b) => ({ high: 2, medium: 1, low: 0 } as any)[b.confidence] - ({ high: 2, medium: 1, low: 0 } as any)[a.confidence])
    .map((r) => ({
      confidence: r.confidence, gap: r.gap,
      order: {
        source: r.order.source, merchant: r.order.merchant_name, amount: r.order.total_amount,
        date: r.order.order_at, subject: r.order.subject, ref: r.order.order_ref ?? null,
        items: r.order.items.map((it) => ({ name: it.name, qty: it.qty ?? null, price: it.price ?? null })),
      },
      txn: { date: r.txn.txn_at, amount: r.txn.amount_inr, merchant: r.txn.merchant, card: r.txn.card_last4 },
    }));
  const out = {
    generated_at: new Date().toISOString(), years: YEARS,
    summary: {
      debits_2y: debits2y.length, matched: rows.length, covered_debits: coveredDebits.length,
      coverage_pct: Number(pct(coveredDebits.length, debits2y.length)),
      with_items: withItems.length, high: conf.high, medium: conf.medium, low: conf.low,
    },
    matches: review,
  };
  writeFileSync(join(process.cwd(), "audit-review.json"), JSON.stringify(out, null, 2));
  console.log(`\nWrote audit-review.json (${review.length} matches). READ-ONLY — nothing written to DB/Gmail.`);
}

main().catch((e) => { console.error("\nAUDIT FAILED:", e.message || e); process.exit(1); });
