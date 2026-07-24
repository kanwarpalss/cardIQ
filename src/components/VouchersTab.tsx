"use client";

import { useEffect, useMemo, useState } from "react";

// Vouchers tab (V2 feature C) — the gift-voucher ledger. Every brand e-voucher
// bought via Gyftr/SmartBuy: what it's for, the card charge that funded it, and
// how much balance is LEFT (spent-down via orders.voucher_draws). The data has
// always existed — this screen is the window onto it. Sibling of the Orders tab
// ("what I bought") and Spend tab ("what I paid"); this is "what I pre-loaded".

type Spend = { orderId: string; merchant: string; amount: number; orderAt: string };
type FundingTxn = { card_last4: string; amount_inr: number; txn_at: string };
type Voucher = {
  id: string;
  brand: string;
  brand_key: string;
  code: string | null;
  face_value: number;
  purchased_at: string;
  valid_till: string | null;
  drawn: number;
  remaining: number;
  spends: Spend[];
  funding_txn: FundingTxn | null;
};

const PAGE = 50;
const fmt = (n: number | null | undefined) =>
  n == null ? "—" : "₹" + Math.round(Number(n)).toLocaleString("en-IN");
const day = (s: string | null) =>
  !s ? "—" : new Date(s).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
/** Codes are redeemable — show only the last 4 so the ledger is scannable
 *  without splashing a live secret across the screen. */
const maskCode = (code: string | null) => (!code ? null : code.length <= 4 ? code : "••••" + code.slice(-4));
const isExpired = (validTill: string | null) =>
  !!validTill && new Date(validTill + "T23:59:59").getTime() < Date.now();

/** Where a voucher sits in its life — the ledger's status badge. */
function StatusBadge({ v }: { v: Voucher }) {
  if (v.remaining <= 0) {
    return <span className="text-2xs px-1.5 py-0.5 rounded-md border whitespace-nowrap text-mist/50 border-rim bg-raised">fully spent</span>;
  }
  if (isExpired(v.valid_till)) {
    return <span className="text-2xs px-1.5 py-0.5 rounded-md border whitespace-nowrap text-ruby border-ruby/30 bg-ruby/5" title="Validity lapsed with balance still on it">⚠ expired · {fmt(v.remaining)} lost</span>;
  }
  if (v.drawn > 0) {
    return <span className="text-2xs px-1.5 py-0.5 rounded-md border whitespace-nowrap text-amber border-amber/30 bg-amber/5">{fmt(v.remaining)} left</span>;
  }
  return <span className="text-2xs px-1.5 py-0.5 rounded-md border whitespace-nowrap text-emerald border-emerald/30 bg-emerald/5">unused · {fmt(v.remaining)}</span>;
}

type BalanceFilter = "all" | "withBalance" | "spent";

export default function VouchersTab() {
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  const [search, setSearch]   = useState("");
  const [brand, setBrand]     = useState("all");
  const [balance, setBalance] = useState<BalanceFilter>("all");
  const [page, setPage]       = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/vouchers");
        const json = await res.json().catch(() => ({}));
        if (!res.ok) { setError(json?.error === "missing_vouchers_table" ? "migration" : json?.error || "Failed to load"); setVouchers([]); return; }
        setVouchers(json.vouchers ?? []);
      } catch {
        setError("Couldn't reach the server. Try again.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);
  useEffect(() => { setPage(1); }, [search, brand, balance]);

  const brands = useMemo(() => {
    const m = new Map<string, string>(); // brand_key → prettiest label seen
    for (const v of vouchers) if (!m.has(v.brand_key)) m.set(v.brand_key, v.brand);
    return ["all", ...[...m.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([k]) => k)];
  }, [vouchers]);
  const brandLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const v of vouchers) if (!m.has(v.brand_key)) m.set(v.brand_key, v.brand);
    return m;
  }, [vouchers]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return vouchers.filter((v) => {
      if (brand !== "all" && v.brand_key !== brand) return false;
      if (balance === "withBalance" && v.remaining <= 0) return false;
      if (balance === "spent" && v.remaining > 0) return false;
      if (!q) return true;
      return [v.brand, v.code].filter(Boolean).join(" ").toLowerCase().includes(q);
    });
  }, [vouchers, search, brand, balance]);

  const stats = useMemo(() => {
    let face = 0, remaining = 0;
    const keys = new Set<string>();
    for (const v of vouchers) { face += v.face_value; remaining += v.remaining; keys.add(v.brand_key); }
    return { count: vouchers.length, face, remaining, brands: keys.size };
  }, [vouchers]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE));
  const pageRows = filtered.slice((page - 1) * PAGE, page * PAGE);

  if (error === "migration") {
    return (
      <div className="max-w-3xl mx-auto px-4 lg:px-8 py-10">
        <div className="rounded-2xl border border-amber/40 bg-amber/5 p-5 text-sm leading-relaxed">
          <div className="font-semibold text-amber mb-1.5">One-time setup needed for Vouchers</div>
          <p className="text-mist/75">
            Open Supabase → <span className="text-mist font-medium">SQL Editor</span>, run{" "}
            <code className="text-amber/90 bg-ink px-1.5 py-0.5 rounded text-xs">supabase/migrations/015_vouchers.sql</code>,
            then run an order sync.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 lg:px-8 py-6 space-y-5">
      <header className="space-y-1">
        <h1 className="font-serif text-2xl text-gold tracking-tight">Vouchers</h1>
        <p className="text-sm text-mist/60 leading-relaxed max-w-xl">
          Every gift voucher you&apos;ve bought via Gyftr — what it&apos;s for, the card charge that funded it,
          and how much balance is left. Spending one against an order draws it down here automatically.
        </p>
      </header>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Vouchers", value: stats.count.toLocaleString("en-IN") },
          { label: "Face value", value: fmt(stats.face) },
          { label: "Balance left", value: fmt(stats.remaining) },
          { label: "Brands", value: stats.brands.toLocaleString("en-IN") },
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
          placeholder="Search brand or code…"
          className="flex-1 min-w-[180px] bg-ink border border-rim rounded-lg px-3 py-1.5 text-sm text-mist placeholder:text-mist/30 focus:border-gold/40 outline-none" />
        <select value={brand} onChange={(e) => setBrand(e.target.value)}
          className="bg-ink border border-rim rounded-lg px-2 py-1.5 text-xs text-mist/75 focus:border-gold/40 outline-none max-w-[180px]">
          {brands.map((b) => <option key={b} value={b}>{b === "all" ? "All brands" : brandLabel.get(b) ?? b}</option>)}
        </select>
        <div className="flex items-center gap-1">
          {(["all", "withBalance", "spent"] as BalanceFilter[]).map((b) => (
            <button key={b} onClick={() => setBalance(b)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                balance === b ? "bg-surface text-gold border border-gold/25" : "text-mist/55 hover:text-mist border border-transparent"
              }`}>
              {b === "all" ? "All" : b === "withBalance" ? "Balance left" : "Fully spent"}
            </button>
          ))}
        </div>
      </div>

      {/* Ledger */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-mist/55 text-sm">Loading…</div>
      ) : error ? (
        <div className="rounded-2xl border border-ruby/30 bg-ruby/5 p-4 text-sm text-ruby">{error}</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-rim bg-surface p-10 text-center text-sm text-mist/70">
          {vouchers.length === 0
            ? "No vouchers yet. Buy a brand voucher via Gyftr/SmartBuy and it'll appear here after the next order sync."
            : "No vouchers match these filters."}
        </div>
      ) : (
        <>
          <div className="rounded-2xl border border-rim bg-surface shadow-card divide-y divide-wire overflow-hidden">
            {pageRows.map((v) => {
              const open = expanded === v.id;
              const pct = v.face_value > 0 ? Math.max(0, Math.min(100, (v.remaining / v.face_value) * 100)) : 0;
              return (
                <div key={v.id}>
                  <button
                    onClick={() => setExpanded(open ? null : v.id)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-raised/40 transition-colors">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-mist/90 truncate">{v.brand}</div>
                      <div className="text-2xs text-mist/45">
                        Bought {day(v.purchased_at)}
                        {v.valid_till ? ` · valid till ${day(v.valid_till)}` : ""}
                      </div>
                      {/* Balance bar: how much of the face value is still unspent */}
                      <div className="mt-1.5 h-1 w-full max-w-[220px] rounded-full bg-raised overflow-hidden">
                        <div className={`h-full rounded-full ${v.remaining <= 0 ? "bg-mist/25" : isExpired(v.valid_till) ? "bg-ruby/50" : "bg-gold/60"}`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                    <StatusBadge v={v} />
                    <div className="text-right shrink-0 w-24">
                      <div className="text-sm font-semibold text-mist tabular-nums">{fmt(v.face_value)}</div>
                      <div className="text-2xs text-mist/40">face value</div>
                    </div>
                    <svg className={`w-3.5 h-3.5 text-mist/40 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.6}>
                      <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  {open && (
                    <div className="px-4 pb-4 pt-1 bg-raised/30 space-y-3 text-xs">
                      <div className="flex flex-wrap gap-x-6 gap-y-1 text-2xs text-mist/55">
                        {maskCode(v.code) && <span>Code {maskCode(v.code)}</span>}
                        <span>Face value {fmt(v.face_value)} · spent {fmt(v.drawn)} · {fmt(v.remaining)} left</span>
                        {v.funding_txn ? (
                          <span className="text-mist/70">
                            Bought for {fmt(v.funding_txn.amount_inr)} on card ••{v.funding_txn.card_last4} · {day(v.funding_txn.txn_at)}
                          </span>
                        ) : (
                          <span className="text-mist/40 italic">Funding card charge not matched</span>
                        )}
                      </div>
                      {v.spends.length > 0 ? (
                        <div className="pt-1 border-t border-wire">
                          <div className="text-2xs uppercase tracking-widest text-mist/40 mb-1">Spent on</div>
                          <ul className="space-y-1">
                            {v.spends.map((s, i) => (
                              <li key={i} className="flex justify-between gap-3 text-mist/75">
                                <span>{s.merchant} <span className="text-mist/40">· {day(s.orderAt)}</span></span>
                                <span className="tabular-nums text-mist/60 shrink-0">−{fmt(s.amount)}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : (
                        <div className="text-2xs text-mist/40 italic pt-1 border-t border-wire">
                          Nothing drawn from this voucher yet — full balance available.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between text-xs text-mist/55">
            <span>{filtered.length.toLocaleString("en-IN")} voucher{filtered.length === 1 ? "" : "s"}</span>
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
