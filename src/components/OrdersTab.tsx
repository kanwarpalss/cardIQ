"use client";

import { useEffect, useMemo, useState } from "react";

// Orders tab (V2 feature C) — the standalone ledger: EVERYTHING you've bought,
// with item detail, cost and merchant, independent of how you paid. Card-matched
// or not, it lives here — so voucher-paid Amazon/Swiggy orders (bought via
// gyftr etc.) that never marry a card charge still have a home. This is the
// "what I bought" source of truth; the Spend tab is "what I paid".

type Item = { name: string; qty?: number | null; price?: number | null };
type LedgerTxn = { card_last4: string; amount_inr: number | string; txn_at: string; merchant: string | null };
type VoucherDraw = { voucherId: string; amount: number; cardTxnId?: string | null; evidence?: "email" | "inferred_split" };
type Order = {
  id: string;
  source: string;
  kind: "order" | "refund";
  order_ref: string | null;
  merchant_name: string | null;
  total_amount: number | string | null;
  order_at: string;
  items: Item[];
  txn_id: string | null;
  match_confidence: "high" | "medium" | "low" | null;
  review_status?: "unmatched" | "pending" | "confirmed" | "rejected" | null;
  raw_subject: string | null;
  txn: LedgerTxn | null;
  voucher_draws?: VoucherDraw[] | null;
  voucher_txn?: LedgerTxn | null; // the card charge that funded the voucher
  voucher_amount?: number | null; // total drawn from vouchers for this order
  card_paid_amount?: number | string | null;
  voucher_paid_amount?: number | string | null;
  voucher_brand_key?: string | null;
  payment_evidence?: "email" | "inferred_split" | null;
  duplicate_of?: string | null;   // same purchase, reported by another entity
};

/** Paid from a voucher balance (traced order → voucher → card charge). */
function isVoucherFunded(o: Order): boolean {
  return Array.isArray(o.voucher_draws) && o.voucher_draws.length > 0;
}

/** A duplicate report of another order's purchase (gateway/shipper vs merchant). */
function isDuplicate(o: Order): boolean {
  return !!o.duplicate_of;
}

const SOURCE_LABELS: Record<string, string> = {
  swiggy: "Swiggy", zomato: "Zomato", bigbasket: "BigBasket", amazon: "Amazon",
  blinkit: "Blinkit", shopify: "Shopify", generic: "Online", razorpay: "Razorpay",
  smartbuy: "SmartBuy", apple: "Apple",
};

const PAGE = 50;
const EIGHT_YEARS_DAYS = 365 * 8;
const fmt = (n: number | string | null | undefined) =>
  n == null ? "—" : "₹" + Math.round(Number(n)).toLocaleString("en-IN");
const day = (s: string) => new Date(s).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const voucherLabel = (key: string) => key.split(/[\s_-]+/).map((part) =>
  part ? part[0].toUpperCase() + part.slice(1) : part
).join(" ");

type LinkFilter = "all" | "linked" | "unlinked";

/** Is this order settled against a card charge? A confirmed match, or (pre-014,
 *  when review_status is absent) any order that still carries a txn. A 'pending'
 *  match is deliberately NOT "linked" yet — it awaits review; 'rejected' has no
 *  txn at all. */
function isCardLinked(o: Order): o is Order & { txn: LedgerTxn } {
  return !!o.txn && o.review_status !== "pending" && o.review_status !== "rejected";
}

/** Where this order sits relative to a card charge — the ledger's link badge. */
function LinkBadge({ o }: { o: Order }) {
  if (isDuplicate(o)) {
    return <span className="text-2xs px-1.5 py-0.5 rounded-md border whitespace-nowrap text-mist/45 border-rim bg-raised" title="Same purchase, reported by another entity (gateway/shipper)">⧉ duplicate</span>;
  }
  if (isCardLinked(o) && isVoucherFunded(o)) {
    return <span className="text-2xs px-1.5 py-0.5 rounded-md border whitespace-nowrap text-amber border-amber/30 bg-amber/5">◈ split ••{o.txn.card_last4}</span>;
  }
  if (isCardLinked(o)) {
    return <span className="text-2xs px-1.5 py-0.5 rounded-md border whitespace-nowrap text-emerald border-emerald/30 bg-emerald/5">✓ card ••{o.txn.card_last4}</span>;
  }
  if (isVoucherFunded(o)) {
    // Paid from a voucher — traced to the funding card charge via the voucher.
    return <span className="text-2xs px-1.5 py-0.5 rounded-md border whitespace-nowrap text-amber border-amber/30 bg-amber/5">◈ voucher{o.voucher_txn ? ` ••${o.voucher_txn.card_last4}` : ""}</span>;
  }
  if (o.review_status === "pending" && o.txn) {
    return <span className="text-2xs px-1.5 py-0.5 rounded-md border whitespace-nowrap text-gold border-gold/30 bg-gold/5">≈ review pending</span>;
  }
  return <span className="text-2xs px-1.5 py-0.5 rounded-md border whitespace-nowrap text-mist/50 border-rim bg-raised">unlinked</span>;
}

export default function OrdersTab() {
  const [orders, setOrders]   = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const [search, setSearch]     = useState("");
  const [source, setSource]     = useState<string>("all");
  const [link, setLink]         = useState<LinkFilter>("all");
  const [showDups, setShowDups] = useState(false);
  const [page, setPage]         = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  const [backfilling, setBackfilling] = useState(false);
  const [backfillMsg, setBackfillMsg] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/orders");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json?.error === "missing_orders_table" ? "migration" : json?.error || "Failed to load"); setOrders([]); return; }
      setOrders(json.orders ?? []);
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);
  useEffect(() => { setPage(1); }, [search, source, link, showDups]);

  // Full-history backfill — pulls 8 years of order emails. Long-running
  // (20–30 min); guarded so it's never a casual click. Streams NDJSON progress.
  async function loadFullHistory() {
    if (backfilling) return;
    if (!window.confirm("Load full order history?\n\nThis scans ~8 years of order emails and can take 20–30 minutes. Keep this tab open until it finishes.")) return;
    setBackfilling(true);
    setBackfillMsg("Starting — scanning 8 years of order emails…");
    try {
      const res = await fetch("/api/gmail/orders/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lookback_days: EIGHT_YEARS_DAYS }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
        throw new Error(e.message || e.error || `HTTP ${res.status}`);
      }
      if (!res.body) throw new Error("No response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done: any = null;
      while (true) {
        const { done: rdone, value } = await reader.read();
        if (rdone) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
          let msg: any;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.status === "error") throw new Error(msg.message || "Sync failed");
          if (msg.status === "done") done = msg;
          if (msg.status === "syncing" && typeof msg.fetched === "number" && msg.total) {
            setBackfillMsg(`Fetching order emails: ${msg.fetched}/${msg.total} · ${msg.new_orders ?? 0} parsed`);
          } else if (msg.message) {
            setBackfillMsg(msg.message);
          }
        }
      }
      const n = done?.new_orders ?? 0;
      const m = done?.matched ?? 0;
      setBackfillMsg(`✓ Done — ${n} new order${n === 1 ? "" : "s"} added${m ? `, ${m} linked to a card` : ""}.`);
      await load();
    } catch (e) {
      setBackfillMsg(`Error: ${(e as Error).message}`);
    } finally {
      setBackfilling(false);
    }
  }

  const sources = useMemo(() => {
    const s = new Set(orders.map((o) => o.source));
    return ["all", ...Array.from(s).sort()];
  }, [orders]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders.filter((o) => {
      // Duplicates (same purchase via another entity) are hidden unless asked for.
      if (!showDups && isDuplicate(o)) return false;
      if (source !== "all" && o.source !== source) return false;
      if (link === "linked"   && !isCardLinked(o)) return false;
      if (link === "unlinked" &&  isCardLinked(o)) return false;
      if (!q) return true;
      const hay = [o.merchant_name, o.order_ref, o.raw_subject, ...o.items.map((i) => i.name)]
        .filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [orders, search, source, link, showDups]);

  const stats = useMemo(() => {
    let value = 0, linked = 0, withItems = 0, total = 0, dups = 0;
    for (const o of orders) {
      // Duplicates (same purchase, another entity) never count toward anything.
      if (isDuplicate(o)) { dups++; continue; }
      total++;
      // Voucher-funded orders are NOT re-tallied — the funding GYFTR card charge
      // already counts that spend (avoids double-counting voucher + order).
      if (o.total_amount != null && o.kind === "order" && !isVoucherFunded(o)) value += Number(o.total_amount);
      if (isCardLinked(o) || isVoucherFunded(o)) linked++;
      if (o.items.length > 0) withItems++;
    }
    return { total, value, linked, withItems, dups };
  }, [orders]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE));
  const pageRows = filtered.slice((page - 1) * PAGE, page * PAGE);

  if (error === "migration") {
    return (
      <div className="max-w-3xl mx-auto px-4 lg:px-8 py-10">
        <div className="rounded-2xl border border-amber/40 bg-amber/5 p-5 text-sm leading-relaxed">
          <div className="font-semibold text-amber mb-1.5">One-time setup needed for Orders</div>
          <p className="text-mist/75">
            Open Supabase → <span className="text-mist font-medium">SQL Editor</span>, run{" "}
            <code className="text-amber/90 bg-ink px-1.5 py-0.5 rounded text-xs">supabase/migrations/011_orders.sql</code>{" "}
            (and 013, 014), then run an order sync.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 lg:px-8 py-6 space-y-5">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-1">
          <h1 className="font-serif text-2xl text-gold tracking-tight">Orders</h1>
          <p className="text-sm text-mist/60 leading-relaxed max-w-xl">
            Everything you&apos;ve bought — items, cost and merchant — no matter how you paid.
            Voucher-paid orders live here too, even when no card charge lines up.
          </p>
        </div>
        <div className="text-right space-y-1">
          <button
            onClick={loadFullHistory}
            disabled={backfilling}
            className="px-3 py-1.5 rounded-lg text-xs font-medium border border-rim text-mist/75 hover:text-mist hover:border-gold/30 disabled:opacity-40 transition-all">
            {backfilling ? "Loading…" : "Load full history (8y)"}
          </button>
          {backfillMsg && <div className="text-2xs text-mist/55 max-w-xs">{backfillMsg}</div>}
        </div>
      </header>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Orders", value: stats.total.toLocaleString("en-IN") },
          { label: "Total value", value: fmt(stats.value) },
          { label: "Linked to a card", value: stats.linked.toLocaleString("en-IN") },
          { label: "With item detail", value: stats.withItems.toLocaleString("en-IN") },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl border border-rim bg-surface p-4 shadow-card">
            <div className="text-2xs uppercase tracking-widest text-mist/45">{s.label}</div>
            <div className="text-xl font-semibold text-mist mt-1 tabular-nums">{s.value}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search item, merchant, order #…"
          className="flex-1 min-w-[180px] bg-ink border border-rim rounded-lg px-3 py-1.5 text-sm text-mist placeholder:text-mist/30 focus:border-gold/40 outline-none" />
        <select value={source} onChange={(e) => setSource(e.target.value)}
          className="bg-ink border border-rim rounded-lg px-2 py-1.5 text-xs text-mist/75 focus:border-gold/40 outline-none">
          {sources.map((s) => <option key={s} value={s}>{s === "all" ? "All sources" : SOURCE_LABELS[s] ?? s}</option>)}
        </select>
        <div className="flex items-center gap-1">
          {(["all", "linked", "unlinked"] as LinkFilter[]).map((l) => (
            <button key={l} onClick={() => setLink(l)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                link === l ? "bg-surface text-gold border border-gold/25" : "text-mist/55 hover:text-mist border border-transparent"
              }`}>
              {l === "all" ? "All" : l === "linked" ? "Card-linked" : "Unlinked"}
            </button>
          ))}
        </div>
        {stats.dups > 0 && (
          <button onClick={() => setShowDups((v) => !v)}
            title="Same-purchase duplicates (a merchant + its payment gateway report the one charge)"
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all border ${
              showDups ? "bg-surface text-mist border-rim" : "text-mist/45 hover:text-mist/70 border-transparent"
            }`}>
            {showDups ? "Hiding none" : `Hidden: ${stats.dups} duplicate${stats.dups === 1 ? "" : "s"}`}
          </button>
        )}
      </div>

      {/* Ledger */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-mist/55 text-sm">Loading…</div>
      ) : error ? (
        <div className="rounded-2xl border border-ruby/30 bg-ruby/5 p-4 text-sm text-ruby">{error}</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-rim bg-surface p-10 text-center text-sm text-mist/70">
          {orders.length === 0
            ? "No orders parsed yet. Run an order sync (Spend → Sync), or load full history above."
            : "No orders match these filters."}
        </div>
      ) : (
        <>
          <div className="rounded-2xl border border-rim bg-surface shadow-card divide-y divide-wire overflow-hidden">
            {pageRows.map((o) => {
              const open = expanded === o.id;
              return (
                <div key={o.id}>
                  <button
                    onClick={() => setExpanded(open ? null : o.id)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-raised/40 transition-colors">
                    <span className="text-2xs uppercase tracking-widest text-gold/60 w-16 shrink-0">
                      {SOURCE_LABELS[o.source] ?? o.source}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-mist/90 truncate">
                        {o.merchant_name || o.raw_subject || SOURCE_LABELS[o.source] || o.source}
                        {o.kind === "refund" && <span className="text-ruby/80 text-xs"> · refund</span>}
                      </div>
                      <div className="text-2xs text-mist/45">
                        {day(o.order_at)}{o.items.length > 0 ? ` · ${o.items.length} item${o.items.length > 1 ? "s" : ""}` : ""}
                      </div>
                    </div>
                    <LinkBadge o={o} />
                    <span className="text-sm font-semibold text-mist tabular-nums w-20 text-right shrink-0">{fmt(o.total_amount)}</span>
                    <svg className={`w-3.5 h-3.5 text-mist/40 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.6}>
                      <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  {open && (
                    <div className="px-4 pb-4 pt-1 bg-raised/30 space-y-3">
                      {o.items.length > 0 ? (
                        <ul className="space-y-1">
                          {o.items.map((it, i) => (
                            <li key={i} className="text-xs text-mist/75 flex justify-between gap-3">
                              <span>{it.qty && it.qty > 1 ? `${it.qty}× ` : ""}{it.name}</span>
                              {it.price != null && <span className="tabular-nums text-mist/50 shrink-0">{fmt(it.price)}</span>}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="text-xs text-mist/40 italic">No line-item detail in this email.</div>
                      )}
                      <div className="flex flex-wrap gap-x-6 gap-y-1 text-2xs text-mist/50 pt-1 border-t border-wire">
                        {o.order_ref && <span>Order #{o.order_ref}</span>}
                        {isCardLinked(o) && isVoucherFunded(o) ? (
                          <span className="text-amber/80">
                            Paid via {fmt(o.voucher_amount)} {o.voucher_brand_key ? `${voucherLabel(o.voucher_brand_key)} ` : ""}voucher
                            {` + ${fmt(o.card_paid_amount ?? o.txn.amount_inr)} on card ••${o.txn.card_last4}`}
                            {o.payment_evidence === "inferred_split" ? " · inferred from exact payment remainder" : " · stated in receipt"}
                          </span>
                        ) : isCardLinked(o) ? (
                          <span>Paid on card ••{o.txn.card_last4} · {fmt(o.txn.amount_inr)} · {day(o.txn.txn_at)}</span>
                        ) : isVoucherFunded(o) ? (
                          <span className="text-amber/80">
                            Paid via {fmt(o.voucher_amount)} voucher
                            {o.voucher_txn ? ` → bought on card ••${o.voucher_txn.card_last4} · ${day(o.voucher_txn.txn_at)}` : ""}
                          </span>
                        ) : (
                          <span>Not linked to a card charge{o.review_status === "pending" ? " (pending review)" : ""}</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between text-xs text-mist/55">
            <span>{filtered.length.toLocaleString("en-IN")} order{filtered.length === 1 ? "" : "s"}</span>
            <div className="flex items-center gap-1.5">
              <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
                className="px-2 py-1 rounded border border-rim hover:border-gold/30 disabled:opacity-20 transition-all">‹</button>
              <span className="tabular-nums">{page} / {pageCount}</span>
              <button disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}
                className="px-2 py-1 rounded border border-rim hover:border-gold/30 disabled:opacity-20 transition-all">›</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
