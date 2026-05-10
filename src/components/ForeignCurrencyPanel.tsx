"use client";

// ForeignCurrencyPanel — non-INR transactions, grouped by currency code.
//
// Display strategy (per user feedback):
//   • Per row:        native amount + INR-on-txn-date + INR-today
//   • Per currency:   sum of native + sum of INR-historical + sum of INR-today
//   • Grand totals:   both INR-historical and INR-today, side by side
//
// This way you can see (a) what you actually paid in INR at the time, and
// (b) what those purchases would cost today — useful for "did INR weaken?"
// trend awareness.
//
// Refresh button only shows if any rows have amount_inr=0 (sentinel for
// "rate fetch failed"). Clicking it now uses an improved historical-fx
// pipeline with ±7 day fallback and Frankfurter as a secondary source,
// so the success rate is much higher than the initial sweep.
//
// Pagination: long currency lists collapse to top 10 by default; per-
// currency expanded txn list paginates at 25 rows.

import { useState } from "react";
import { formatCurrency, toInr, RATES_AS_OF } from "@/lib/forex";

const TXN_PAGE = 25;

export type ForeignTxn = {
  id: string;
  card_last4: string;
  original_currency: string | null;
  original_amount: number | null;
  amount_inr: number;            // historical INR (rate on txn date), or 0 if unavailable
  merchant: string | null;
  category: string | null;
  txn_at: string;
  txn_type: "debit" | "credit";
};

interface Props {
  transactions: ForeignTxn[];
}

interface Bucket {
  currency: string;
  totalOriginal: number;
  totalInrHistorical: number;
  totalInrToday: number;
  count: number;
  missingRateCount: number;
  txns: ForeignTxn[];
}

export default function ForeignCurrencyPanel({ transactions }: Props) {
  const [expandedCurrency, setExpandedCurrency] = useState<string | null>(null);
  const [refreshing,       setRefreshing]       = useState(false);
  const [refreshMsg,       setRefreshMsg]       = useState<string | null>(null);
  const [txnPage,          setTxnPage]          = useState<Record<string, number>>({});

  if (transactions.length === 0) return null;

  // ── Group by currency ─────────────────────────────────────────────────
  const buckets: Record<string, Bucket> = {};
  for (const t of transactions) {
    const code = (t.original_currency || "???").toUpperCase();
    if (!buckets[code]) buckets[code] = {
      currency: code,
      totalOriginal: 0,
      totalInrHistorical: 0,
      totalInrToday: 0,
      count: 0,
      missingRateCount: 0,
      txns: [],
    };
    const native    = Number(t.original_amount ?? 0);
    const inrHist   = Number(t.amount_inr ?? 0);
    const inrToday  = toInr(native, code) ?? 0;     // null → unknown → 0
    const sign      = t.txn_type === "credit" ? -1 : 1;

    buckets[code].totalOriginal      += sign * native;
    buckets[code].totalInrHistorical += sign * inrHist;
    buckets[code].totalInrToday      += sign * inrToday;
    if (inrHist === 0) buckets[code].missingRateCount++;
    buckets[code].count++;
    buckets[code].txns.push(t);
  }

  // Sort by historical INR (the primary metric) descending.
  const list = Object.values(buckets).sort((a, b) => b.totalInrHistorical - a.totalInrHistorical);

  const grandInrHistorical = list.reduce((s, b) => s + b.totalInrHistorical, 0);
  const grandInrToday      = list.reduce((s, b) => s + b.totalInrToday,      0);
  const totalMissing       = list.reduce((s, b) => s + b.missingRateCount,   0);
  const inrDelta           = grandInrToday - grandInrHistorical;

  async function refreshRates() {
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      const res = await fetch("/api/transactions/refresh-fx", { method: "POST" });
      const json = await res.json();
      setRefreshMsg(json.message || `Updated ${json.updated ?? 0} txns.`);
    } catch (e) {
      setRefreshMsg(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section className="rounded-2xl border border-rim bg-surface p-5 shadow-card space-y-4">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-2xs uppercase tracking-widest text-mist/30">Foreign currency transactions</h3>
          <p className="text-2xs text-mist/30 mt-0.5">
            {transactions.length} txn{transactions.length > 1 ? "s" : ""} across {list.length} currenc{list.length > 1 ? "ies" : "y"}
            {" · "}INR shown both at txn date and at today&apos;s rate.
          </p>
        </div>
        {totalMissing > 0 && (
          <button
            onClick={refreshRates}
            disabled={refreshing}
            className="text-xs px-3 py-1.5 rounded-lg bg-gold/15 text-gold border border-gold/30 hover:bg-gold/25 transition-colors disabled:opacity-50"
            title={`${totalMissing} txn(s) missing INR conversion. Click to fetch with ±7-day fallback + Frankfurter backup.`}
          >
            {refreshing ? "Refreshing…" : `Refresh missing rates (${totalMissing})`}
          </button>
        )}
      </div>

      {refreshMsg && (
        <div className="text-2xs text-mist/60 px-3 py-2 rounded-lg bg-raised border border-rim">
          {refreshMsg} <span className="text-mist/30">— refresh the page to see updated totals.</span>
        </div>
      )}

      {/* ── Per-currency rows ────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        {list.map((b) => {
          const expanded   = expandedCurrency === b.currency;
          const page       = txnPage[b.currency] ?? 1;
          const sortedTxns = b.txns.slice().sort((a, c) => new Date(c.txn_at).getTime() - new Date(a.txn_at).getTime());
          const totalPages = Math.ceil(sortedTxns.length / TXN_PAGE);
          const visibleTxns = sortedTxns.slice((page - 1) * TXN_PAGE, page * TXN_PAGE);

          return (
            <div key={b.currency} className="rounded-xl bg-raised border border-rim overflow-hidden">
              <button
                onClick={() => setExpandedCurrency(expanded ? null : b.currency)}
                className="w-full px-4 py-3 hover:bg-hover transition-colors"
              >
                <div className="grid grid-cols-[auto_1fr_auto_auto_auto] items-baseline gap-x-4 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono font-semibold text-gold/80 w-10 text-left">{b.currency}</span>
                    <svg className={`w-3 h-3 opacity-30 transition-transform ${expanded ? "rotate-180" : ""}`}
                         fill="none" viewBox="0 0 10 6">
                      <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"/>
                    </svg>
                  </div>
                  <div className="flex items-center gap-2 text-2xs text-mist/30 justify-self-start">
                    {b.count} txn{b.count > 1 ? "s" : ""}
                    {b.missingRateCount > 0 && (
                      <span className="text-amber">· {b.missingRateCount} missing rate</span>
                    )}
                  </div>
                  <span className="font-semibold text-mist/90 tabular-nums text-right">
                    {formatCurrency(b.totalOriginal, b.currency)}
                  </span>
                  <span className="font-medium text-gold/90 tabular-nums text-right text-xs">
                    ₹{Math.round(b.totalInrHistorical).toLocaleString("en-IN")}
                    <div className="text-2xs text-mist/30 font-normal">at txn date</div>
                  </span>
                  <span className="font-medium text-mist/70 tabular-nums text-right text-xs">
                    ₹{Math.round(b.totalInrToday).toLocaleString("en-IN")}
                    <div className="text-2xs text-mist/30 font-normal">today</div>
                  </span>
                </div>
              </button>

              {/* ── Expanded txn list ───────────────────────────────────── */}
              {expanded && (
                <div className="border-t border-rim divide-y divide-wire">
                  {visibleTxns.map((t) => {
                    const native   = Number(t.original_amount ?? 0);
                    const inrHist  = Number(t.amount_inr ?? 0);
                    const inrToday = toInr(native, t.original_currency) ?? 0;
                    return (
                      <div key={t.id} className="px-4 py-2.5 grid grid-cols-[auto_1fr_auto_auto_auto] items-baseline gap-x-4 text-xs">
                        <span className="text-mist/40 tabular-nums">
                          {new Date(t.txn_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit" })}
                        </span>
                        <div className="min-w-0 flex items-center gap-2">
                          <span className="text-mist/80 truncate">{t.merchant || "—"}</span>
                          <span className="text-2xs text-mist/30 shrink-0">··{t.card_last4}</span>
                        </div>
                        <span className={`tabular-nums font-medium text-right ${
                          t.txn_type === "credit" ? "text-emerald" : "text-mist/90"
                        }`}>
                          {t.txn_type === "credit" ? "+" : ""}
                          {formatCurrency(native, t.original_currency)}
                        </span>
                        <span className="tabular-nums text-right text-gold/80">
                          {inrHist > 0
                            ? `≈ ₹${Math.round(inrHist).toLocaleString("en-IN")}`
                            : <span className="text-amber" title="Click 'Refresh missing rates' to fetch">no rate</span>}
                        </span>
                        <span className="tabular-nums text-right text-mist/50">
                          ≈ ₹{Math.round(inrToday).toLocaleString("en-IN")}
                        </span>
                      </div>
                    );
                  })}

                  {/* Pager */}
                  {totalPages > 1 && (
                    <div className="px-4 py-2 flex items-center justify-between text-2xs">
                      <span className="text-mist/30">
                        {(page - 1) * TXN_PAGE + 1}–{Math.min(page * TXN_PAGE, sortedTxns.length)} of {sortedTxns.length}
                      </span>
                      <div className="flex items-center gap-2">
                        <button disabled={page <= 1}
                          onClick={() => setTxnPage((m) => ({ ...m, [b.currency]: page - 1 }))}
                          className="px-2 py-0.5 rounded text-mist/60 hover:text-gold disabled:opacity-30 disabled:cursor-not-allowed">‹ Prev</button>
                        <span className="text-mist/40 tabular-nums">{page}/{totalPages}</span>
                        <button disabled={page >= totalPages}
                          onClick={() => setTxnPage((m) => ({ ...m, [b.currency]: page + 1 }))}
                          className="px-2 py-0.5 rounded text-mist/60 hover:text-gold disabled:opacity-30 disabled:cursor-not-allowed">Next ›</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Grand totals ──────────────────────────────────────────────────── */}
      <div className="space-y-1.5 pt-3 border-t border-wire text-xs">
        <div className="flex items-center justify-between">
          <span className="text-mist/50">Total in INR (rates on txn dates):</span>
          <span className="font-semibold text-gold tabular-nums">
            ₹{Math.round(grandInrHistorical).toLocaleString("en-IN")}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-mist/50">Total in INR (today&apos;s rates, as of {RATES_AS_OF}):</span>
          <span className="font-semibold text-mist/80 tabular-nums">
            ₹{Math.round(grandInrToday).toLocaleString("en-IN")}
          </span>
        </div>
        <div className="flex items-center justify-between pt-1 border-t border-wire/50">
          <span className="text-2xs text-mist/30">Difference (today vs txn date):</span>
          <span className={`text-2xs tabular-nums font-medium ${
            inrDelta >= 0 ? "text-amber" : "text-emerald"
          }`}>
            {inrDelta >= 0 ? "+" : ""}₹{Math.round(inrDelta).toLocaleString("en-IN")}
            {grandInrHistorical > 0 && (
              <span className="text-mist/30 ml-1">({((inrDelta / grandInrHistorical) * 100).toFixed(1)}%)</span>
            )}
          </span>
        </div>
      </div>
    </section>
  );
}
