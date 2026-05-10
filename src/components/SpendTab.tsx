"use client";

import { useEffect, useMemo, useState } from "react";
import { CARD_REGISTRY } from "@/lib/cards/registry";
import { CATEGORIES }    from "@/lib/categories";
import PeriodPicker      from "./PeriodPicker";
import MerchantPanel     from "./MerchantPanel";
import SyncPanel         from "./SyncPanel";
import TransactionsTable from "./TransactionsTable";
import ForeignCurrencyPanel from "./ForeignCurrencyPanel";

// ── Types ───────────────────────────────────────────────────────
type Txn = {
  id: string; card_last4: string; amount_inr: number;
  original_currency: string | null;
  original_amount:   number | null;
  merchant: string | null; category: string | null;
  txn_at: string; txn_type: "debit" | "credit"; notes?: string | null;
};
type CardRow = { id: string; last4: string; nickname: string | null; product_key: string };
type AllData = { transactions: Txn[]; cards: CardRow[]; last_sync: string | null };

// ── Utils ────────────────────────────────────────────────────────────────────
const fmt  = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
const ymd  = (d: Date)   => d.toISOString().slice(0, 10);
const cardLabel = (c: CardRow) => c.nickname || CARD_REGISTRY[c.product_key]?.display_name || c.product_key;

function defaultRange() {
  const d = new Date();
  return {
    from: ymd(new Date(d.getFullYear(), d.getMonth(), 1)),
    to:   ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0)),
  };
}

const MERCHANT_PAGE = 10;
const CATEGORY_PAGE = 10;   // mirror MERCHANT_PAGE for visual consistency
const MILESTONE     = 150_000;

// ── Component ────────────────────────────────────────────────────────────────
export default function SpendTab() {
  const init = defaultRange();
  const [fromDate, setFromDate] = useState(init.from);
  const [toDate,   setToDate]   = useState(init.to);
  const [selectedCards, setSelectedCards] = useState<Set<string>>(new Set(["all"]));
  const [txnType, setTxnType]   = useState<"all" | "debit" | "credit">("all");
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

  const [allData,  setAllData]  = useState<AllData | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [recat,    setRecat]    = useState<string | null>(null);

  // Merchant table state
  const [merchantSort,  setMerchantSort]  = useState<"total" | "count" | "name">("total");
  const [merchantPage,  setMerchantPage]  = useState(1);
  const [merchantQuery, setMerchantQuery] = useState("");
  const [showAllMerchants, setShowAllMerchants] = useState(false);

  // Category panel — same UX as merchants (filter + sort + paginate). The
  // category list is small for most users (<20) but power users with
  // user-defined buckets can have 50+ — so we paginate from the start.
  const [categorySort,  setCategorySort]  = useState<"total" | "count" | "name">("total");
  const [categoryPage,  setCategoryPage]  = useState(1);
  const [categoryQuery, setCategoryQuery] = useState("");
  const [showAllCategories, setShowAllCategories] = useState(false);

  // ── Data fetch ─────────────────────────────────────────────────────────────
  async function loadAll() {
    setLoading(true);
    try {
      const res = await fetch("/api/transactions/all");
      if (res.ok) setAllData(await res.json());
    } finally { setLoading(false); }
  }

  useEffect(() => { loadAll(); }, []);
  useEffect(() => { setMerchantPage(1); setCategoryPage(1); }, [fromDate, toDate, selectedCards, txnType, categoryFilter]);

  // ── Handlers ───────────────────────────────────────────────────────────────
  function toggleCard(last4: string) {
    setSelectedCards((prev) => {
      const next = new Set(prev);
      if (last4 === "all") return new Set(["all"]);
      next.delete("all");
      if (next.has(last4)) { next.delete(last4); if (!next.size) return new Set(["all"]); }
      else next.add(last4);
      return next;
    });
  }

  async function recategorize() {
    setRecat("Re-categorizing…");
    const res  = await fetch("/api/recategorize", { method: "POST" });
    const json = await res.json();
    setRecat(res.ok ? `✓ Re-categorized ${json.updated}/${json.total} transactions` : `Error: ${json.error}`);
    if (res.ok) loadAll();
  }

  async function handleMerchantSave(old_name: string, new_name: string, category: string) {
    const res = await fetch("/api/merchant-mappings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ old_name, new_name, category }),
    });
    if (!res.ok) return;
    setAllData((prev) => prev ? {
      ...prev,
      transactions: prev.transactions.map((t) =>
        t.merchant === old_name ? { ...t, merchant: new_name, category } : t
      ),
    } : prev);
  }

  async function handleTxnCategoryChange(txnId: string, category: string) {
    const res = await fetch(`/api/transactions/${txnId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category }),
    });
    if (!res.ok) return;
    setAllData((prev) => prev ? {
      ...prev,
      transactions: prev.transactions.map((t) => t.id === txnId ? { ...t, category } : t),
    } : prev);
  }

  async function handleTxnNotesChange(txnId: string, notes: string) {
    const res = await fetch(`/api/transactions/${txnId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    });
    if (!res.ok) return;
    setAllData((prev) => prev ? {
      ...prev,
      transactions: prev.transactions.map((t) => t.id === txnId ? { ...t, notes } : t),
    } : prev);
  }

  // ── Memos ──────────────────────────────────────────────────────────────────
  const allCategories = useMemo(() => {
    const set = new Set<string>(CATEGORIES);
    for (const t of allData?.transactions ?? []) {
      if (t.category?.trim()) set.add(t.category.trim());
    }
    return Array.from(set);
  }, [allData]);

  const existingNotes = useMemo(() => {
    const set = new Set<string>();
    for (const t of allData?.transactions ?? []) {
      if (t.notes?.trim()) set.add(t.notes.trim());
    }
    return Array.from(set);
  }, [allData]);

  const filteredTxns = useMemo(() => {
    if (!allData) return [];
    const fromMs = new Date(fromDate + "T00:00:00").getTime();
    const toMs   = new Date(toDate   + "T23:59:59").getTime();
    const cardSet = selectedCards.has("all") ? null : selectedCards;
    return allData.transactions.filter((t) => {
      const ts = new Date(t.txn_at).getTime();
      if (ts < fromMs || ts > toMs) return false;
      if (cardSet && !cardSet.has(t.card_last4)) return false;
      if (txnType !== "all" && t.txn_type !== txnType) return false;
      if (categoryFilter && t.category !== categoryFilter) return false;
      return true;
    });
  }, [allData, fromDate, toDate, selectedCards, txnType, categoryFilter]);

  // Currency split: keep INR txns for all the ₹-denominated panels (totals,
  // merchants, categories, milestones) and route foreign-currency txns to a
  // dedicated panel. Legacy rows with a NULL original_currency are treated
  // as INR (true for everything synced before multi-currency support).
  const inrTxns = useMemo(
    () => filteredTxns.filter((t) => !t.original_currency || t.original_currency.toUpperCase() === "INR"),
    [filteredTxns]
  );
  const foreignTxns = useMemo(
    () => filteredTxns.filter((t) => t.original_currency && t.original_currency.toUpperCase() !== "INR"),
    [filteredTxns]
  );

  const aggregates = useMemo(() => {
    // INR-ONLY aggregates. Foreign txns get their own panel below.
    const debits  = inrTxns.filter((t) => t.txn_type === "debit");
    const credits = inrTxns.filter((t) => t.txn_type === "credit");
    const total_debit  = debits.reduce((s, t) => s + Number(t.amount_inr), 0);
    const total_credit = credits.reduce((s, t) => s + Number(t.amount_inr), 0);

    const totals: Record<string, number> = {};
    for (const t of debits) totals[t.card_last4] = (totals[t.card_last4] || 0) + Number(t.amount_inr);

    const merchantMap: Record<string, { total: number; count: number; category: string }> = {};
    for (const t of debits) {
      const k = t.merchant || "(missing)";
      if (!merchantMap[k]) merchantMap[k] = { total: 0, count: 0, category: t.category || "Uncategorized" };
      merchantMap[k].total += Number(t.amount_inr);
      merchantMap[k].count++;
    }
    const by_merchant = Object.entries(merchantMap)
      .map(([merchant, v]) => ({ merchant, ...v }))
      .sort((a, b) => b.total - a.total);

    const categoryMap: Record<string, { total: number; count: number }> = {};
    for (const t of debits) {
      const k = t.category || "Uncategorized";
      if (!categoryMap[k]) categoryMap[k] = { total: 0, count: 0 };
      categoryMap[k].total += Number(t.amount_inr);
      categoryMap[k].count++;
    }
    const by_category = Object.entries(categoryMap)
      .map(([category, v]) => ({ category, ...v }))
      .sort((a, b) => b.total - a.total);

    return {
      summary: { total_debit, total_credit, net: total_debit - total_credit,
        txn_count: inrTxns.length, debit_count: debits.length, credit_count: credits.length },
      by_merchant, by_category, totals,
    };
  }, [inrTxns]);

  const filteredMerchants = useMemo(() => {
    let list = aggregates.by_merchant;
    if (merchantQuery) {
      const q = merchantQuery.toLowerCase();
      list = list.filter((m) => m.merchant.toLowerCase().includes(q) || m.category.toLowerCase().includes(q));
    }
    return [...list].sort((a, b) => {
      if (merchantSort === "name")  return a.merchant.localeCompare(b.merchant);
      if (merchantSort === "count") return b.count - a.count;
      return b.total - a.total;
    });
  }, [aggregates.by_merchant, merchantQuery, merchantSort]);

  const visibleMerchants = showAllMerchants
    ? filteredMerchants.slice((merchantPage - 1) * MERCHANT_PAGE, merchantPage * MERCHANT_PAGE)
    : filteredMerchants.slice(0, MERCHANT_PAGE);
  const merchantPageCount  = Math.ceil(filteredMerchants.length / MERCHANT_PAGE);
  const maxMerchantTotal   = filteredMerchants[0]?.total ?? 1;

  // Same filter+sort+paginate pattern for categories.
  const filteredCategories = useMemo(() => {
    let list = aggregates.by_category;
    if (categoryQuery) {
      const q = categoryQuery.toLowerCase();
      list = list.filter((c) => c.category.toLowerCase().includes(q));
    }
    return [...list].sort((a, b) => {
      if (categorySort === "name")  return a.category.localeCompare(b.category);
      if (categorySort === "count") return b.count - a.count;
      return b.total - a.total;
    });
  }, [aggregates.by_category, categoryQuery, categorySort]);

  const visibleCategories = showAllCategories
    ? filteredCategories.slice((categoryPage - 1) * CATEGORY_PAGE, categoryPage * CATEGORY_PAGE)
    : filteredCategories.slice(0, CATEGORY_PAGE);
  const categoryPageCount = Math.ceil(filteredCategories.length / CATEGORY_PAGE);
  const maxCategoryFiltered = filteredCategories[0]?.total ?? 1;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-6 pb-20">

      {/* ── Sync panel ────────────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-rim bg-surface p-5 shadow-card">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="font-serif text-base font-semibold text-gold mb-0.5">Gmail Sync</h2>
            <p className="text-xs text-mist/40">Emails are archived locally once and never re-downloaded.</p>
          </div>
          <button onClick={recategorize}
            className="text-xs text-mist/40 hover:text-mist/70 transition-colors whitespace-nowrap">
            Re-categorize
          </button>
        </div>
        <div className="mt-4">
          <SyncPanel onSyncComplete={loadAll} />
        </div>
        {recat && (
          <div className={`mt-3 text-xs px-3 py-2 rounded-lg border ${
            recat.startsWith("✓") ? "border-emerald/30 bg-emerald/5 text-emerald" : "border-ruby/30 bg-ruby/5 text-ruby"
          }`}>{recat}</div>
        )}
      </section>

      {/* ── View filters ──────────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-rim bg-surface p-5 shadow-card space-y-4">

        {/* Period row */}
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-2xs uppercase tracking-widest text-mist/30 w-12 shrink-0">Period</span>
          <PeriodPicker
            from={fromDate}
            to={toDate}
            onChange={(f, t) => { setFromDate(f); setToDate(t); }}
          />
        </div>

        {/* Cards row */}
        {allData && allData.cards.length > 0 && (
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-2xs uppercase tracking-widest text-mist/30 w-12 shrink-0">Cards</span>
            <div className="flex flex-wrap gap-1.5">
              <FilterPill active={selectedCards.has("all")} onClick={() => toggleCard("all")}>All</FilterPill>
              {allData.cards.map((c) => (
                <FilterPill key={c.id} active={selectedCards.has(c.last4)} onClick={() => toggleCard(c.last4)}>
                  {cardLabel(c)} <span className="opacity-50 font-normal">··{c.last4}</span>
                </FilterPill>
              ))}
            </div>
          </div>
        )}

        {/* Type row */}
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-2xs uppercase tracking-widest text-mist/30 w-12 shrink-0">Type</span>
          <div className="flex gap-1.5">
            {(["all", "debit", "credit"] as const).map((t) => (
              <FilterPill key={t} active={txnType === t} onClick={() => setTxnType(t)}>
                <span className="capitalize">{t}</span>
              </FilterPill>
            ))}
          </div>
          {categoryFilter && (
            <button onClick={() => setCategoryFilter(null)}
              className="ml-auto text-xs text-mist/40 hover:text-mist/70 flex items-center gap-1 transition-colors">
              <span className="text-gold/60 font-medium">{categoryFilter}</span>
              <span>× clear</span>
            </button>
          )}
        </div>
      </section>

      {loading && !allData && (
        <div className="flex items-center justify-center py-16 text-mist/30 text-sm">Loading…</div>
      )}

      {allData && filteredTxns.length === 0 && (
        <div className="text-center py-16 text-mist/30 text-sm">
          No transactions in this range. Try widening the period or syncing Gmail.
        </div>
      )}

      {allData && filteredTxns.length > 0 && (
        <>
          {/* ── Summary tiles ──────────────────────────────────────────── */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatTile label="Spent"       value={fmt(aggregates.summary.total_debit)}  sub={`${aggregates.summary.debit_count} debits`}    accent="gold" />
            <StatTile label="Refunded"    value={fmt(aggregates.summary.total_credit)} sub={`${aggregates.summary.credit_count} credits`}   accent="emerald" />
            <StatTile label="Net"         value={fmt(aggregates.summary.net)}           sub="debits − refunds"                              accent="gold" />
            <StatTile label="Transactions" value={String(aggregates.summary.txn_count)} sub={`${fromDate.slice(0,7)} → ${toDate.slice(0,7)}`} accent="muted" />
          </div>

          {/* ── Milestone bars ─────────────────────────────────────────── */}
          {txnType !== "credit" && !categoryFilter && allData.cards.length > 0 && (
            <section className="rounded-2xl border border-rim bg-surface p-5 shadow-card space-y-4">
              <h3 className="text-2xs uppercase tracking-widest text-mist/30">Milestones</h3>
              {allData.cards
                .filter((c) => selectedCards.has("all") || selectedCards.has(c.last4))
                .map((card) => {
                  const spent     = aggregates.totals[card.last4] || 0;
                  const spec      = CARD_REGISTRY[card.product_key];
                  const milestone = spec?.milestones_monthly?.[0]?.spend_inr ?? MILESTONE;
                  const pct       = Math.min((spent / milestone) * 100, 100);
                  return (
                    <div key={card.id} className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-mist/80">
                          {cardLabel(card)}
                          <span className="opacity-30 text-xs ml-1.5">··{card.last4}</span>
                        </span>
                        <span className="font-semibold text-gold tabular-nums">{fmt(spent)}</span>
                      </div>
                      <div className="h-1.5 bg-ink rounded-full overflow-hidden">
                        <div className="h-full bg-gold-shimmer rounded-full transition-all duration-700"
                          style={{ width: `${pct}%` }} />
                      </div>
                      <div className="flex justify-between text-2xs text-mist/30">
                        <span>{Math.round(pct)}% of {fmt(milestone)} milestone</span>
                        {pct < 100
                          ? <span>{fmt(milestone - spent)} to go</span>
                          : <span className="text-emerald">Reached ✓</span>}
                      </div>
                    </div>
                  );
                })}
            </section>
          )}

          {/* ── Category + Merchant panels ─────────────────────────────── */}
          <div className="grid md:grid-cols-2 gap-4">

            {/* Category */}
            <section className="rounded-2xl border border-rim bg-surface p-5 shadow-card space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-2xs uppercase tracking-widest text-mist/30">By category</h3>
                <span className="text-2xs text-mist/30">
                  {filteredCategories.length}
                  {filteredCategories.length !== aggregates.by_category.length && ` / ${aggregates.by_category.length}`}
                </span>
              </div>
              <div className="flex gap-2">
                <input type="text" placeholder="Filter…" value={categoryQuery}
                  onChange={(e) => { setCategoryQuery(e.target.value); setCategoryPage(1); }}
                  className="flex-1 bg-ink border border-rim rounded-lg px-3 py-1.5 text-xs text-mist placeholder:text-mist/25 focus:border-gold/40 outline-none" />
                <select value={categorySort} onChange={(e) => setCategorySort(e.target.value as typeof categorySort)}
                  className="bg-ink border border-rim rounded-lg px-2 py-1.5 text-xs text-mist/70 focus:border-gold/40 outline-none">
                  <option value="total">By total</option>
                  <option value="count">By count</option>
                  <option value="name">By name</option>
                </select>
              </div>
              <div className="space-y-1.5">
                {visibleCategories.map((c) => {
                  const active = categoryFilter === c.category;
                  return (
                    <button key={c.category} onClick={() => setCategoryFilter(active ? null : c.category)}
                      className={`w-full text-left px-3 py-2 -mx-3 rounded-xl transition-all ${
                        active ? "bg-gold/8" : "hover:bg-raised"
                      }`}>
                      <div className="flex justify-between items-baseline text-sm">
                        <span className={active ? "text-gold" : "text-mist/80"}>{c.category}</span>
                        <span className={active ? "text-gold font-semibold" : "text-mist/60 font-medium"}>
                          {fmt(c.total)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-1.5">
                        <div className="flex-1 h-0.5 bg-ink rounded-full overflow-hidden">
                          <div className="h-full bg-gold/50 rounded-full transition-all"
                            style={{ width: `${(c.total / maxCategoryFiltered) * 100}%` }} />
                        </div>
                        <span className="text-2xs text-mist/25 w-10 text-right shrink-0">{c.count}×</span>
                      </div>
                    </button>
                  );
                })}
              </div>
              {filteredCategories.length > CATEGORY_PAGE && (
                <div className="pt-2 border-t border-wire flex items-center justify-between">
                  <button onClick={() => { setShowAllCategories((v) => !v); setCategoryPage(1); }}
                    className="text-xs text-mist/40 hover:text-gold transition-colors">
                    {showAllCategories ? "Show top 10" : `Show all ${filteredCategories.length}`}
                  </button>
                  {showAllCategories && categoryPageCount > 1 && (
                    <Pager page={categoryPage} count={categoryPageCount} onChange={setCategoryPage} />
                  )}
                </div>
              )}
            </section>

            {/* Merchant */}
            <section className="rounded-2xl border border-rim bg-surface p-5 shadow-card space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-2xs uppercase tracking-widest text-mist/30">By merchant</h3>
                <span className="text-2xs text-mist/30">
                  {filteredMerchants.length}
                  {filteredMerchants.length !== aggregates.by_merchant.length && ` / ${aggregates.by_merchant.length}`}
                </span>
              </div>
              <div className="flex gap-2">
                <input type="text" placeholder="Filter…" value={merchantQuery}
                  onChange={(e) => { setMerchantQuery(e.target.value); setMerchantPage(1); }}
                  className="flex-1 bg-ink border border-rim rounded-lg px-3 py-1.5 text-xs text-mist placeholder:text-mist/25 focus:border-gold/40 outline-none" />
                <select value={merchantSort} onChange={(e) => setMerchantSort(e.target.value as typeof merchantSort)}
                  className="bg-ink border border-rim rounded-lg px-2 py-1.5 text-xs text-mist/70 focus:border-gold/40 outline-none">
                  <option value="total">By total</option>
                  <option value="count">By count</option>
                  <option value="name">By name</option>
                </select>
              </div>
              <MerchantPanel
                merchants={visibleMerchants}
                maxTotal={maxMerchantTotal}
                categories={allCategories}
                onSave={handleMerchantSave}
              />
              {filteredMerchants.length > MERCHANT_PAGE && (
                <div className="pt-2 border-t border-wire flex items-center justify-between">
                  <button onClick={() => { setShowAllMerchants((v) => !v); setMerchantPage(1); }}
                    className="text-xs text-mist/40 hover:text-gold transition-colors">
                    {showAllMerchants ? "Show top 10" : `Show all ${filteredMerchants.length}`}
                  </button>
                  {showAllMerchants && merchantPageCount > 1 && (
                    <Pager page={merchantPage} count={merchantPageCount} onChange={setMerchantPage} />
                  )}
                </div>
              )}
            </section>
          </div>

          {/* ── Transactions table (INR only) ───────────────────────────────── */}
          <TransactionsTable
            transactions={inrTxns}
            cards={allData.cards}
            categories={allCategories}
            existingNotes={existingNotes}
            onMerchantSave={handleMerchantSave}
            onCategoryChange={handleTxnCategoryChange}
            onNotesChange={handleTxnNotesChange}
          />

          {/* ── Foreign currency panel (renders only if foreign txns exist) ── */}
          <ForeignCurrencyPanel transactions={foreignTxns} />
        </>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function FilterPill({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick}
      className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
        active
          ? "bg-gold text-ink shadow-glow-gold"
          : "bg-raised border border-rim hover:border-gold/30 text-mist/60 hover:text-mist"
      }`}>
      {children}
    </button>
  );
}

function StatTile({ label, value, sub, accent }: {
  label: string; value: string; sub: string; accent: "gold" | "emerald" | "muted";
}) {
  const valClass = accent === "gold" ? "text-gold" : accent === "emerald" ? "text-emerald" : "text-mist/80";
  return (
    <div className="rounded-2xl border border-rim bg-surface p-4 shadow-card">
      <div className="text-2xs uppercase tracking-widest text-mist/30 mb-2">{label}</div>
      <div className={`font-serif text-2xl font-semibold tabular-nums ${valClass}`}>{value}</div>
      <div className="text-2xs text-mist/30 mt-1">{sub}</div>
    </div>
  );
}

function Pager({ page, count, onChange }: { page: number; count: number; onChange: (p: number) => void }) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <button disabled={page <= 1} onClick={() => onChange(page - 1)}
        className="px-2 py-1 rounded border border-rim hover:border-gold/30 disabled:opacity-20 transition-all">‹</button>
      <span className="text-mist/40 tabular-nums">{page}/{count}</span>
      <button disabled={page >= count} onClick={() => onChange(page + 1)}
        className="px-2 py-1 rounded border border-rim hover:border-gold/30 disabled:opacity-20 transition-all">›</button>
    </div>
  );
}
