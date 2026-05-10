"use client";

// ForeignCurrencyPanel — non-INR transactions, grouped by currency code.
//
// Why a separate panel: pre-fix, foreign amounts were summed into ₹ totals,
// inflating numbers wildly (an IDR 12,272,062 hotel stay looked like
// ₹1.2 crore). Now those rows are quarantined here.
//
// INR display: we use the HISTORICAL rate (amount_inr field, set at the
// time of sync using the FX rate on the txn date). Today's rate is shown
// as a secondary hint so the user can answer "what would this cost me
// today?" but the primary number is the historically-accurate one.
//
// "Refresh rates" button appears only if some rows have amount_inr=0
// (a sentinel meaning the rate couldn't be fetched at sync time, usually
// due to network blips or a rare currency the API doesn't have yet).

import { useState } from "react";
import { formatCurrency, toInr, RATES_AS_OF } from "@/lib/forex";

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
  totalInrHistorical: number;     // sum of amount_inr (historical, at-txn-date)
  count: number;
  missingRateCount: number;       // txns where amount_inr=0 (need refresh)
  txns: ForeignTxn[];
}

export default function ForeignCurrencyPanel({ transactions }: Props) {
  const [showInInr, setShowInInr]               = useState(false);
  const [expandedCurrency, setExpandedCurrency] = useState<string | null>(null);
  const [refreshing, setRefreshing]             = useState(false);
  const [refreshMsg, setRefreshMsg]             = useState<string | null>(null);

  if (transactions.length === 0) return null;

  // Group by currency. Debits add, credits subtract — same convention as INR.
  const buckets: Record<string, Bucket> = {};
  for (const t of transactions) {
    const code = (t.original_currency || "???").toUpperCase();
    if (!buckets[code]) buckets[code] = {
      currency: code,
      totalOriginal: 0,
      totalInrHistorical: 0,
      count: 0,
      missingRateCount: 0,
      txns: [],
    };
    const amt = Number(t.original_amount ?? 0);
    const inr = Number(t.amount_inr ?? 0);
    const sign = t.txn_type === "credit" ? -1 : 1;
    buckets[code].totalOriginal      += sign * amt;
    buckets[code].totalInrHistorical += sign * inr;
    if (inr === 0) buckets[code].missingRateCount++;
    buckets[code].count++;
    buckets[code].txns.push(t);
  }

  // Sort by historical INR (the primary metric) descending.
  const list = Object.values(buckets).sort((a, b) => b.totalInrHistorical - a.totalInrHistorical);

  const grandInrHistorical = list.reduce((s, b) => s + b.totalInrHistorical, 0);
  const grandInrToday      = list.reduce((s, b) => s + (toInr(b.totalOriginal, b.currency) ?? 0), 0);
  const totalMissing       = list.reduce((s, b) => s + b.missingRateCount, 0);

  async function refreshRates() {
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      const res = await fetch("/api/transactions/refresh-fx", { method: "POST" });
      const json = await res.json();
      setRefreshMsg(json.message || `Updated ${json.updated ?? 0} txns.`);
      // The page-level data won't auto-refresh — the user can re-click their
      // date filter or refresh the page to see the new INR amounts. Keep
      // the message visible so they know the action succeeded.
    } catch (e) {
      setRefreshMsg(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section className="rounded-2xl border border-rim bg-surface p-5 shadow-card space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-2xs uppercase tracking-widest text-mist/30">Foreign currency transactions</h3>
          <p className="text-2xs text-mist/30 mt-0.5">
            {transactions.length} txn{transactions.length > 1 ? "s" : ""} across {list.length} currenc{list.length > 1 ? "ies" : "y"} ·
            INR amounts use the historical rate on the txn date.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {totalMissing > 0 && (
            <button
              onClick={refreshRates}
              disabled={refreshing}
              className="text-xs px-3 py-1.5 rounded-lg bg-gold/15 text-gold border border-gold/30 hover:bg-gold/25 transition-colors disabled:opacity-50"
              title={`${totalMissing} txn(s) are missing INR conversion. Click to fetch historical rates.`}
            >
              {refreshing ? "Refreshing…" : `Refresh rates (${totalMissing})`}
            </button>
          )}
          <button
            onClick={() => setShowInInr((v) => !v)}
            className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
              showInInr
                ? "bg-gold/15 text-gold border border-gold/30"
                : "bg-raised border border-rim text-mist/60 hover:text-mist hover:border-gold/30"
            }`}
          >
            {showInInr ? "Native" : "₹ at txn date"}
          </button>
        </div>
      </div>

      {refreshMsg && (
        <div className="text-2xs text-mist/60 px-3 py-2 rounded-lg bg-raised border border-rim">
          {refreshMsg} <span className="text-mist/30">— refresh the page to see updated totals.</span>
        </div>
      )}

      {/* Per-currency rows */}
      <div className="space-y-1.5">
        {list.map((b) => {
          const inrToday = toInr(b.totalOriginal, b.currency);
          const expanded = expandedCurrency === b.currency;
          return (
            <div key={b.currency} className="rounded-xl bg-raised border border-rim overflow-hidden">
              <button
                onClick={() => setExpandedCurrency(expanded ? null : b.currency)}
                className="w-full px-4 py-3 flex items-center justify-between hover:bg-hover transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono font-semibold text-gold/80 w-10 text-left">{b.currency}</span>
                  <span className="text-2xs text-mist/30">{b.count} txn{b.count > 1 ? "s" : ""}</span>
                  {b.missingRateCount > 0 && (
                    <span className="text-2xs text-amber">{b.missingRateCount} missing rate</span>
                  )}
                </div>
                <div className="flex items-baseline gap-3">
                  <span className="text-sm font-semibold text-mist/90 tabular-nums">
                    {showInInr
                      ? "₹" + Math.round(b.totalInrHistorical).toLocaleString("en-IN")
                      : formatCurrency(b.totalOriginal, b.currency)}
                  </span>
                  {!showInInr && (
                    <span className="text-2xs text-mist/30 tabular-nums">
                      ≈ ₹{Math.round(b.totalInrHistorical).toLocaleString("en-IN")}
                    </span>
                  )}
                  <svg className={`w-3 h-3 opacity-30 transition-transform ${expanded ? "rotate-180" : ""}`}
                       fill="none" viewBox="0 0 10 6">
                    <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"/>
                  </svg>
                </div>
              </button>

              {/* Expanded txn list */}
              {expanded && (
                <div className="border-t border-rim divide-y divide-wire">
                  {b.txns
                    .slice()
                    .sort((a, c) => new Date(c.txn_at).getTime() - new Date(a.txn_at).getTime())
                    .map((t) => (
                      <div key={t.id} className="px-4 py-2.5 flex items-center justify-between text-xs">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="text-mist/40 tabular-nums shrink-0">
                            {new Date(t.txn_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                          </span>
                          <span className="text-mist/80 truncate">{t.merchant || "—"}</span>
                          <span className="text-2xs text-mist/30 shrink-0">··{t.card_last4}</span>
                        </div>
                        <div className="flex items-baseline gap-2 shrink-0 ml-3">
                          <span className={`tabular-nums font-medium ${
                            t.txn_type === "credit" ? "text-emerald" : "text-mist/90"
                          }`}>
                            {t.txn_type === "credit" ? "+" : ""}
                            {formatCurrency(Number(t.original_amount ?? 0), t.original_currency)}
                          </span>
                          {Number(t.amount_inr) > 0 ? (
                            <span className="text-2xs text-mist/30 tabular-nums">
                              ≈ ₹{Math.round(Number(t.amount_inr)).toLocaleString("en-IN")}
                            </span>
                          ) : (
                            <span className="text-2xs text-amber" title="Click 'Refresh rates' to fetch this">no rate</span>
                          )}
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Grand total + footnote */}
      <div className="space-y-1 pt-3 border-t border-wire text-xs">
        <div className="flex items-center justify-between">
          <span className="text-mist/40">Total in INR (rates on txn dates):</span>
          <span className="font-semibold text-gold tabular-nums">
            ₹{Math.round(grandInrHistorical).toLocaleString("en-IN")}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-mist/30">≈ at today&apos;s rates ({RATES_AS_OF}):</span>
          <span className="text-mist/40 tabular-nums">
            ₹{Math.round(grandInrToday).toLocaleString("en-IN")}
          </span>
        </div>
      </div>
    </section>
  );
}
