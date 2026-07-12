"use client";

// Insights (V2 feature E) — read-only analytics over what's already synced:
//   • month-over-month spend (last 12 months, click a bar to focus a month)
//   • two-tier category breakdown for the focused month
//   • top merchants for the focused month
//   • top items, powered by matched order emails (feature C's items jsonb)
//
// All aggregation happens client-side from /api/transactions/all — same
// payload SpendTab uses, no new endpoints. INR-only, debits-only, matching
// SpendTab's rule (foreign-currency txns live in their own panel there).

import { useEffect, useMemo, useState } from "react";

type Txn = {
  id: string; amount_inr: number;
  original_currency: string | null;
  merchant: string | null; category: string | null;
  subcategory?: string | null;
  txn_at: string; txn_type: "debit" | "credit";
};
type OrderApiRow = {
  id: string; txn_id: string | null; source: string; kind: "order" | "refund";
  merchant_name: string | null; order_at: string;
  items: Array<{ name: string; qty?: number; price?: number }>;
};
type AllData = { transactions: Txn[]; orders?: OrderApiRow[] };

const fmt = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

const monthKey   = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const monthLabel = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "short", year: "numeric" });
};
const monthShort = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "short" });
};

export default function InsightsTab() {
  const [allData, setAllData] = useState<AllData | null>(null);
  const [loading, setLoading] = useState(true);
  const [month, setMonth]     = useState<string>(monthKey(new Date()));

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/transactions/all");
        if (res.ok) setAllData(await res.json());
      } finally { setLoading(false); }
    })();
  }, []);

  // INR debits only — the currency SpendTab totals are denominated in.
  const debits = useMemo(
    () => (allData?.transactions ?? []).filter(
      (t) => t.txn_type === "debit" && (!t.original_currency || t.original_currency.toUpperCase() === "INR")
    ),
    [allData]
  );

  // ── Last 12 calendar months, oldest → newest, current month included. ──
  const months = useMemo(() => {
    const now = new Date();
    const keys: string[] = [];
    for (let i = 11; i >= 0; i--) {
      keys.push(monthKey(new Date(now.getFullYear(), now.getMonth() - i, 1)));
    }
    const totals = new Map<string, number>(keys.map((k) => [k, 0]));
    for (const t of debits) {
      const k = monthKey(new Date(t.txn_at));
      if (totals.has(k)) totals.set(k, totals.get(k)! + Number(t.amount_inr));
    }
    return keys.map((k) => ({ key: k, total: totals.get(k) ?? 0 }));
  }, [debits]);

  const maxMonthTotal = Math.max(1, ...months.map((m) => m.total));

  const thisIdx    = months.findIndex((m) => m.key === monthKey(new Date()));
  const thisMonth  = thisIdx >= 0 ? months[thisIdx].total : 0;
  const lastMonth  = thisIdx > 0 ? months[thisIdx - 1].total : 0;
  const momPct     = lastMonth > 0 ? ((thisMonth - lastMonth) / lastMonth) * 100 : null;
  const monthsWithSpend = months.filter((m) => m.total > 0);
  const avgMonth   = monthsWithSpend.length
    ? monthsWithSpend.reduce((s, m) => s + m.total, 0) / monthsWithSpend.length
    : 0;

  // ── Focused-month slices ──
  const monthTxns = useMemo(
    () => debits.filter((t) => monthKey(new Date(t.txn_at)) === month),
    [debits, month]
  );

  // Two-tier category breakdown: category totals, with named-subcategory
  // rows beneath and an "(other)" remainder when the tiers don't cover it.
  const categoryTiers = useMemo(() => {
    const cats = new Map<string, { total: number; count: number; subs: Map<string, number> }>();
    for (const t of monthTxns) {
      const c = t.category || "Uncategorized";
      if (!cats.has(c)) cats.set(c, { total: 0, count: 0, subs: new Map() });
      const e = cats.get(c)!;
      e.total += Number(t.amount_inr);
      e.count++;
      if (t.subcategory) e.subs.set(t.subcategory, (e.subs.get(t.subcategory) ?? 0) + Number(t.amount_inr));
    }
    return Array.from(cats.entries())
      .map(([category, e]) => {
        const subs = Array.from(e.subs.entries()).sort((a, b) => b[1] - a[1]);
        const covered = subs.reduce((s, [, v]) => s + v, 0);
        if (subs.length > 0 && e.total - covered > 0.5) subs.push(["(no subcategory)", e.total - covered]);
        return { category, total: e.total, count: e.count, subs };
      })
      .sort((a, b) => b.total - a.total);
  }, [monthTxns]);

  const maxCatTotal = categoryTiers[0]?.total ?? 1;

  const topMerchants = useMemo(() => {
    const map = new Map<string, { total: number; count: number }>();
    for (const t of monthTxns) {
      const k = t.merchant || "(missing)";
      if (!map.has(k)) map.set(k, { total: 0, count: 0 });
      const e = map.get(k)!;
      e.total += Number(t.amount_inr);
      e.count++;
    }
    return Array.from(map.entries())
      .map(([merchant, e]) => ({ merchant, ...e }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);
  }, [monthTxns]);

  // Top items from matched order emails in the focused month. qty defaults
  // to 1; spend is only summed where the email carried a line price, so the
  // ₹ column is honest ("—" when prices weren't in the emails).
  const topItems = useMemo(() => {
    const map = new Map<string, { name: string; qty: number; spend: number; hasPrice: boolean }>();
    for (const o of allData?.orders ?? []) {
      if (o.kind !== "order" || monthKey(new Date(o.order_at)) !== month) continue;
      for (const it of o.items ?? []) {
        const k = it.name.toLowerCase();
        if (!map.has(k)) map.set(k, { name: it.name, qty: 0, spend: 0, hasPrice: false });
        const e = map.get(k)!;
        e.qty += it.qty ?? 1;
        if (it.price != null) { e.spend += it.price; e.hasPrice = true; }
      }
    }
    return Array.from(map.values())
      .sort((a, b) => (b.spend - a.spend) || (b.qty - a.qty))
      .slice(0, 10);
  }, [allData, month]);

  // ── Render ──
  if (loading) {
    return <div className="flex items-center justify-center py-24 text-mist/55 text-sm">Loading…</div>;
  }
  if (!allData || debits.length === 0) {
    return (
      <div className="max-w-6xl mx-auto px-6 py-16 text-center text-mist/55 text-sm">
        No transactions yet — sync Gmail from the Spend tab first, then come back for the good stuff.
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-6 pb-20">

      {/* Header + month focus */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-serif text-xl font-semibold text-gold">Insights</h2>
          <p className="text-xs text-mist/55 mt-0.5">Where the money actually went.</p>
        </div>
        <select value={month} onChange={(e) => setMonth(e.target.value)}
          className="bg-surface border border-rim rounded-lg px-3 py-1.5 text-xs text-mist focus:border-gold/40 outline-none">
          {[...months].reverse().map((m) => (
            <option key={m.key} value={m.key}>{monthLabel(m.key)}</option>
          ))}
        </select>
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label="This month" value={fmt(thisMonth)} sub={monthLabel(months[thisIdx]?.key ?? month)} accent="gold" />
        <Tile label="Last month" value={fmt(lastMonth)} sub={thisIdx > 0 ? monthLabel(months[thisIdx - 1].key) : "—"} accent="muted" />
        <Tile label="Month over month"
          value={momPct === null ? "—" : `${momPct >= 0 ? "+" : ""}${momPct.toFixed(0)}%`}
          sub={momPct === null ? "no previous month" : momPct >= 0 ? "spending more" : "spending less"}
          accent={momPct !== null && momPct > 0 ? "ruby" : "emerald"} />
        <Tile label="Monthly average" value={fmt(avgMonth)} sub={`${monthsWithSpend.length} active months`} accent="muted" />
      </div>

      {/* Month-over-month bars */}
      <section className="rounded-2xl border border-rim bg-surface p-5 shadow-card">
        <h3 className="text-2xs uppercase tracking-widest text-mist/55 mb-4">Spend by month · click a bar to focus</h3>
        <div className="flex items-end gap-1.5 sm:gap-2">
          {months.map((m) => {
            const focused = m.key === month;
            return (
              <button key={m.key} onClick={() => setMonth(m.key)} title={`${monthLabel(m.key)} — ${fmt(m.total)}`}
                className="flex-1 flex flex-col items-center gap-1.5 group min-w-0">
                <span className={`text-2xs tabular-nums truncate max-w-full transition-opacity ${
                  focused ? "text-gold" : "text-mist/35 opacity-0 group-hover:opacity-100"
                }`}>{m.total > 0 ? fmt(m.total) : ""}</span>
                <div
                  className={`w-full rounded-t-md transition-all ${
                    focused ? "bg-gold" : m.total > 0 ? "bg-gold/25 group-hover:bg-gold/45" : "bg-ink"
                  }`}
                  style={{ height: `${Math.max(3, (m.total / maxMonthTotal) * 120)}px` }}
                />
                <span className={`text-2xs ${focused ? "text-gold" : "text-mist/45"}`}>{monthShort(m.key)}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Category tiers + top merchants */}
      <div className="grid md:grid-cols-2 gap-4">
        <section className="rounded-2xl border border-rim bg-surface p-5 shadow-card space-y-3">
          <div className="flex items-baseline justify-between">
            <h3 className="text-2xs uppercase tracking-widest text-mist/55">By category · {monthLabel(month)}</h3>
            <span className="text-2xs text-mist/45">{monthTxns.length} txns</span>
          </div>
          {categoryTiers.length === 0 && (
            <div className="text-xs text-mist/45 italic py-4">No spend in {monthLabel(month)}.</div>
          )}
          <div className="space-y-3">
            {categoryTiers.map((c) => (
              <div key={c.category}>
                <div className="flex justify-between items-baseline text-sm">
                  <span className="text-mist/80">{c.category}</span>
                  <span className="text-mist/70 font-medium tabular-nums">{fmt(c.total)}</span>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <div className="flex-1 h-1 bg-ink rounded-full overflow-hidden">
                    <div className="h-full bg-gold/50 rounded-full" style={{ width: `${(c.total / maxCatTotal) * 100}%` }} />
                  </div>
                  <span className="text-2xs text-mist/30 w-8 text-right shrink-0">{c.count}×</span>
                </div>
                {c.subs.length > 0 && (
                  <div className="mt-1 space-y-0.5">
                    {c.subs.map(([sub, total]) => (
                      <div key={sub} className="flex justify-between items-baseline pl-4 text-xs">
                        <span className={sub === "(no subcategory)" ? "text-mist/35 italic" : "text-mist/55"}>↳ {sub}</span>
                        <span className="text-mist/45 tabular-nums">{fmt(total)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-rim bg-surface p-5 shadow-card space-y-3">
          <h3 className="text-2xs uppercase tracking-widest text-mist/55">Top merchants · {monthLabel(month)}</h3>
          {topMerchants.length === 0 && (
            <div className="text-xs text-mist/45 italic py-4">No spend in {monthLabel(month)}.</div>
          )}
          <div className="space-y-2">
            {topMerchants.map((m, i) => (
              <div key={m.merchant} className="flex items-baseline gap-2 text-sm">
                <span className="text-2xs text-mist/30 w-4 shrink-0 tabular-nums">{i + 1}</span>
                <span className="text-mist/80 truncate flex-1">{m.merchant}</span>
                <span className="text-2xs text-mist/40 shrink-0">{m.count}×</span>
                <span className="text-mist/70 font-medium tabular-nums shrink-0">{fmt(m.total)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Top items — powered by matched order emails */}
      <section className="rounded-2xl border border-rim bg-surface p-5 shadow-card space-y-3">
        <div className="flex items-baseline justify-between">
          <h3 className="text-2xs uppercase tracking-widest text-mist/55">Top items · {monthLabel(month)}</h3>
          <span className="text-2xs text-mist/45">from matched order emails</span>
        </div>
        {topItems.length === 0 ? (
          <div className="text-xs text-mist/45 italic py-2">
            No order items for {monthLabel(month)} — items appear once order emails (Swiggy, Zomato, BigBasket, Amazon) are synced and matched.
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-x-8 gap-y-2">
            {topItems.map((it) => (
              <div key={it.name} className="flex items-baseline gap-2 text-sm">
                <span className="text-mist/80 truncate flex-1">{it.name}</span>
                <span className="text-2xs text-mist/40 shrink-0">×{it.qty}</span>
                <span className="text-mist/70 font-medium tabular-nums shrink-0">{it.hasPrice ? fmt(it.spend) : "—"}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Tile({ label, value, sub, accent }: {
  label: string; value: string; sub: string; accent: "gold" | "emerald" | "ruby" | "muted";
}) {
  const valClass =
    accent === "gold"    ? "text-gold"    :
    accent === "emerald" ? "text-emerald" :
    accent === "ruby"    ? "text-ruby"    : "text-mist/80";
  return (
    <div className="rounded-2xl border border-rim bg-surface p-4 shadow-card">
      <div className="text-2xs uppercase tracking-widest text-mist/55 mb-2">{label}</div>
      <div className={`font-serif text-2xl font-semibold tabular-nums ${valClass}`}>{value}</div>
      <div className="text-2xs text-mist/55 mt-1">{sub}</div>
    </div>
  );
}
