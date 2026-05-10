"use client";

// ForeignCurrencyPanel — non-INR transactions, grouped by currency code.
//
// Why a separate panel: pre-fix, foreign amounts were summed into ₹ totals,
// inflating numbers wildly (an IDR 12,272,062 hotel stay looked like
// ₹1.2 crore). Now those rows are quarantined here. The user sees the
// real native amount (e.g. "IDR 12,272,062") and can optionally toggle
// "Show in INR (today's rate)" for a rough estimate using the static
// forex table in lib/forex.ts.
//
// This panel only appears when there's at least one foreign-currency txn
// in the active filter window — zero chrome for users who never travel.

import { useState } from "react";
import { formatCurrency, toInr, RATES_AS_OF } from "@/lib/forex";

export type ForeignTxn = {
  id: string;
  card_last4: string;
  original_currency: string | null;
  original_amount: number | null;
  amount_inr: number;            // present if Axis/etc. provided "Indian Rupee Equivalent"
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
  count: number;
  txns: ForeignTxn[];
}

export default function ForeignCurrencyPanel({ transactions }: Props) {
  const [showInInr, setShowInInr] = useState(false);
  const [expandedCurrency, setExpandedCurrency] = useState<string | null>(null);

  if (transactions.length === 0) return null;

  // Group by currency. Debits add, credits subtract — same convention as INR.
  const buckets: Record<string, Bucket> = {};
  for (const t of transactions) {
    const code = (t.original_currency || "???").toUpperCase();
    if (!buckets[code]) buckets[code] = { currency: code, totalOriginal: 0, count: 0, txns: [] };
    const amt = Number(t.original_amount ?? 0);
    buckets[code].totalOriginal += t.txn_type === "credit" ? -amt : amt;
    buckets[code].count++;
    buckets[code].txns.push(t);
  }

  // Sort by INR-equivalent descending so the biggest spend is first; falls
  // back to currency code for unknown currencies (inr_estimate = null).
  const list = Object.values(buckets).sort((a, b) => {
    const ai = toInr(a.totalOriginal, a.currency) ?? -Infinity;
    const bi = toInr(b.totalOriginal, b.currency) ?? -Infinity;
    return bi - ai;
  });

  const grandInrEstimate = list.reduce((s, b) => s + (toInr(b.totalOriginal, b.currency) ?? 0), 0);

  return (
    <section className="rounded-2xl border border-rim bg-surface p-5 shadow-card space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-2xs uppercase tracking-widest text-mist/30">Foreign currency transactions</h3>
          <p className="text-2xs text-mist/30 mt-0.5">
            {transactions.length} txn{transactions.length > 1 ? "s" : ""} across {list.length} currenc{list.length > 1 ? "ies" : "y"} ·
            kept separate from INR totals so the dashboard isn&apos;t inflated.
          </p>
        </div>
        <button
          onClick={() => setShowInInr((v) => !v)}
          className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
            showInInr
              ? "bg-gold/15 text-gold border border-gold/30"
              : "bg-raised border border-rim text-mist/60 hover:text-mist hover:border-gold/30"
          }`}
        >
          {showInInr ? "Native" : "≈ INR (today)"}
        </button>
      </div>

      {/* Per-currency rows */}
      <div className="space-y-1.5">
        {list.map((b) => {
          const inrEq    = toInr(b.totalOriginal, b.currency);
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
                </div>
                <div className="flex items-baseline gap-3">
                  <span className="text-sm font-semibold text-mist/90 tabular-nums">
                    {showInInr && inrEq !== null
                      ? "₹" + Math.round(inrEq).toLocaleString("en-IN")
                      : formatCurrency(b.totalOriginal, b.currency)}
                  </span>
                  {!showInInr && inrEq !== null && (
                    <span className="text-2xs text-mist/30 tabular-nums">
                      ≈ ₹{Math.round(inrEq).toLocaleString("en-IN")}
                    </span>
                  )}
                  {inrEq === null && (
                    <span className="text-2xs text-amber" title="No exchange rate available">unrecognized currency</span>
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
                        <span className={`tabular-nums font-medium shrink-0 ml-3 ${
                          t.txn_type === "credit" ? "text-emerald" : "text-mist/90"
                        }`}>
                          {t.txn_type === "credit" ? "+" : ""}
                          {formatCurrency(Number(t.original_amount ?? 0), t.original_currency)}
                        </span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Grand total + footnote */}
      <div className="flex items-center justify-between pt-3 border-t border-wire text-xs">
        <span className="text-mist/40">
          Approx grand total in INR (today&apos;s rates, as of {RATES_AS_OF}):
        </span>
        <span className="font-semibold text-gold tabular-nums">
          ≈ ₹{Math.round(grandInrEstimate).toLocaleString("en-IN")}
        </span>
      </div>
    </section>
  );
}
