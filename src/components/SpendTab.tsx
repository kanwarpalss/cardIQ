"use client";

import { useEffect, useMemo, useState } from "react";
import { CARD_REGISTRY } from "@/lib/cards/registry";
import { CATEGORIES } from "@/lib/categories";
import MerchantPanel from "./MerchantPanel";
import TransactionsTable from "./TransactionsTable";

type Txn = {
  id: string;
  card_last4: string;
  amount_inr: number;
  merchant: string | null;
  category: string | null;
  txn_at: string;
  txn_type: "debit" | "credit";
  notes?: string | null;
};

type CardRow = { id: string; last4: string; nickname: string | null; product_key: string };

type AllData = { transactions: Txn[]; cards: CardRow[]; last_sync: string | null };

const PRESETS = [
  { label: "This month",    f: () => { const d = new Date(); return [new Date(d.getFullYear(), d.getMonth(), 1), new Date(d.getFullYear(), d.getMonth() + 1, 0)] as const; } },
  { label: "Last month",    f: () => { const d = new Date(); return [new Date(d.getFullYear(), d.getMonth() - 1, 1), new Date(d.getFullYear(), d.getMonth(), 0)] as const; } },
  { label: "Last 3 months", f: () => { const d = new Date(); return [new Date(d.getFullYear(), d.getMonth() - 2, 1), new Date(d.getFullYear(), d.getMonth() + 1, 0)] as const; } },
  { label: "Last 6 months", f: () => { const d = new Date(); return [new Date(d.getFullYear(), d.getMonth() - 5, 1), new Date(d.getFullYear(), d.getMonth() + 1, 0)] as const; } },
  { label: "Last 12 months",f: () => { const d = new Date(); return [new Date(d.getFullYear() - 1, d.getMonth(), 1), new Date(d.getFullYear(), d.getMonth() + 1, 0)] as const; } },
];

const MERCHANT_PAGE = 10;
const MILESTONE = 150000;

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const fmt = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
const cardLabel = (c: CardRow) => c.nickname || CARD_REGISTRY[c.product_key]?.display_name || c.product_key;

export default function SpendTab() {
  const [d0, d1] = PRESETS[0].f();
  const [fromDate, setFromDate] = useState(ymd(d0));
  const [toDate, setToDate] = useState(ymd(d1));
  const [activePreset, setActivePreset] = useState<string>("This month");
  const [selectedCards, setSelectedCards] = useState<Set<string>>(new Set(["all"]));
  const [txnType, setTxnType] = useState<"all" | "debit" | "credit">("all");
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

  // Single source of truth — fetched once, then everything else is in-memory.
  const [allData, setAllData] = useState<AllData | null>(null);
  const [loading, setLoading] = useState(false);

  // Sync state
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  // Section state
  const [merchantSort, setMerchantSort] = useState<"total" | "count" | "name">("total");
  const [merchantPage, setMerchantPage] = useState(1);
  const [merchantQuery, setMerchantQuery] = useState("");
  const [showAllMerchants, setShowAllMerchants] = useState(false);

  async function loadAll() {
    setLoading(true);
    try {
      const res = await fetch("/api/transactions/all");
      if (res.ok) setAllData(await res.json());
    } finally { setLoading(false); }
  }

  useEffect(() => { loadAll(); }, []);
  useEffect(() => { setMerchantPage(1); }, [fromDate, toDate, selectedCards, txnType, categoryFilter]);

  function applyPreset(p: typeof PRESETS[0]) {
    const [a, b] = p.f();
    setFromDate(ymd(a));
    setToDate(ymd(b));
    setActivePreset(p.label);
  }

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

  async function sync() {
    setSyncing(true); setSyncResult(null); setSyncProgress(null);
    try {
      const res = await fetch("/api/gmail/sync", { method: "POST" });
      if (!res.ok || !res.body) throw new Error("Sync failed");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value).split("\n").filter(Boolean)) {
          try {
            const msg = JSON.parse(line);
            if (msg.status === "listing") setSyncProgress("Counting emails…");
            else if (msg.status === "syncing") {
              const pct = msg.total ? Math.round((msg.fetched / msg.total) * 100) : 0;
              setSyncProgress(`${pct}%  ·  ${msg.fetched ?? 0} / ${msg.total ?? "?"} emails  ·  ${msg.new_txns ?? 0} new transactions`);
            } else if (msg.status === "done") {
              const newCount = msg.new_txns ?? 0;
              setSyncResult(newCount > 0
                ? `✓ ${newCount} new transaction${newCount === 1 ? "" : "s"} added (${msg.fetched} emails checked)`
                : `✓ Already up to date — ${msg.fetched} emails checked, 0 new transactions`);
              setSyncProgress(null); loadAll();
            } else if (msg.status === "error") throw new Error(msg.message);
          } catch (e) { if ((e as Error).message === "Sync failed") throw e; }
        }
      }
    } catch (e) { setSyncResult(`Error: ${(e as Error).message}`); setSyncProgress(null); }
    finally { setSyncing(false); }
  }

  async function syncBackfill() {
    if (!confirm("This will fetch all your card emails going back 5 years — it can take 10–20 minutes. Your app will stay usable. Continue?")) return;
    setSyncing(true); setSyncResult(null); setSyncProgress(null);
    try {
      const res = await fetch("/api/gmail/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lookback_days: 1825 }), // 5 years
      });
      if (!res.ok || !res.body) throw new Error("Sync failed");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value).split("\n").filter(Boolean)) {
          try {
            const msg = JSON.parse(line);
            if (msg.status === "listing") setSyncProgress("Counting 5-year history…");
            else if (msg.status === "syncing") {
              const pct = msg.total ? Math.round((msg.fetched / msg.total) * 100) : 0;
              setSyncProgress(`${pct}%  ·  ${msg.fetched ?? 0} / ${msg.total ?? "?"} emails  ·  ${msg.new_txns ?? 0} new transactions`);
            } else if (msg.status === "done") {
              const newCount = msg.new_txns ?? 0;
              setSyncResult(newCount > 0
                ? `✓ Full history: ${newCount} new transaction${newCount === 1 ? "" : "s"} added (${msg.fetched} emails scanned). Change the date range above to see older data.`
                : `✓ Full history scanned — ${msg.fetched} emails checked. All ${msg.parsed} transactions were already in your database. Change the date range above to explore all periods.`);
              setSyncProgress(null); loadAll();
            } else if (msg.status === "error") throw new Error(msg.message);
          } catch (e) { if ((e as Error).message === "Sync failed") throw e; }
        }
      }
    } catch (e) { setSyncResult(`Error: ${(e as Error).message}`); setSyncProgress(null); }
    finally { setSyncing(false); }
  }

  async function recategorize() {
    setSyncResult("Re-categorizing…");
    const res = await fetch("/api/recategorize", { method: "POST" });
    const json = await res.json();
    if (res.ok) {
      setSyncResult(`✓ Re-categorized ${json.updated} of ${json.total} transactions`);
      loadAll();
    } else setSyncResult(`Error: ${json.error}`);
  }

  /** Rename a merchant and/or change its category for ALL transactions. */
  async function handleMerchantSave(old_name: string, new_name: string, category: string) {
    const res = await fetch("/api/merchant-mappings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ old_name, new_name, category }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setSyncResult(`Error saving mapping: ${err.error ?? "unknown"}`);
      return;
    }
    // Optimistic update: patch allData in-memory so the UI reflects instantly.
    setAllData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        transactions: prev.transactions.map((t) =>
          t.merchant === old_name ? { ...t, merchant: new_name, category } : t
        ),
      };
    });
  }

  /** Update a single transaction's category. */
  async function handleTxnCategoryChange(txnId: string, category: string) {
    const res = await fetch(`/api/transactions/${txnId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setSyncResult(`Error updating category: ${err.error ?? "unknown"}`);
      return;
    }
    // Optimistic update.
    setAllData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        transactions: prev.transactions.map((t) =>
          t.id === txnId ? { ...t, category } : t
        ),
      };
    });
  }

  /** Update a single transaction's note (free-form text, "" clears it). */
  async function handleTxnNotesChange(txnId: string, notes: string) {
    const res = await fetch(`/api/transactions/${txnId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setSyncResult(`Error saving note: ${err.error ?? "unknown"}`);
      return;
    }
    setAllData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        transactions: prev.transactions.map((t) =>
          t.id === txnId ? { ...t, notes } : t
        ),
      };
    });
  }

  /** Canonical CATEGORIES + any custom categories the user has used before. */
  const allCategories = useMemo(() => {
    const set = new Set<string>(CATEGORIES);
    for (const t of allData?.transactions ?? []) {
      if (t.category && t.category.trim()) set.add(t.category.trim());
    }
    return Array.from(set);
  }, [allData]);

  /** All distinct existing notes — fed to TransactionsTable for autofill. */
  const existingNotes = useMemo(() => {
    const set = new Set<string>();
    for (const t of allData?.transactions ?? []) {
      if (t.notes && t.notes.trim()) set.add(t.notes.trim());
    }
    return Array.from(set);
  }, [allData]);

  // ── Client-side filtering pipeline (global filters only; search/amount live in TransactionsTable) ──
  const filteredTxns = useMemo(() => {
    if (!allData) return [];
    const fromMs  = new Date(fromDate + "T00:00:00").getTime();
    const toMs    = new Date(toDate + "T23:59:59").getTime();
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

  // Aggregations
  const aggregates = useMemo(() => {
    const debits  = filteredTxns.filter((t) => t.txn_type === "debit");
    const credits = filteredTxns.filter((t) => t.txn_type === "credit");
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
    const by_merchant = Object.entries(merchantMap).map(([merchant, v]) => ({ merchant, ...v })).sort((a, b) => b.total - a.total);

    const categoryMap: Record<string, { total: number; count: number }> = {};
    for (const t of debits) {
      const k = t.category || "Uncategorized";
      if (!categoryMap[k]) categoryMap[k] = { total: 0, count: 0 };
      categoryMap[k].total += Number(t.amount_inr);
      categoryMap[k].count++;
    }
    const by_category = Object.entries(categoryMap).map(([category, v]) => ({ category, ...v })).sort((a, b) => b.total - a.total);

    return {
      summary: {
        total_debit, total_credit, net: total_debit - total_credit,
        txn_count: filteredTxns.length, debit_count: debits.length, credit_count: credits.length,
      },
      by_merchant, by_category, totals,
    };
  }, [filteredTxns]);

  // Sort/filter merchants
  const filteredMerchants = useMemo(() => {
    let list = aggregates.by_merchant;
    if (merchantQuery) {
      const q = merchantQuery.toLowerCase();
      list = list.filter((m) => m.merchant.toLowerCase().includes(q) || m.category.toLowerCase().includes(q));
    }
    return [...list].sort((a, b) => {
      if (merchantSort === "name") return a.merchant.localeCompare(b.merchant);
      if (merchantSort === "count") return b.count - a.count;
      return b.total - a.total;
    });
  }, [aggregates.by_merchant, merchantQuery, merchantSort]);

  const visibleMerchants = showAllMerchants
    ? filteredMerchants.slice((merchantPage - 1) * MERCHANT_PAGE, merchantPage * MERCHANT_PAGE)
    : filteredMerchants.slice(0, MERCHANT_PAGE);
  const merchantPageCount = Math.ceil(filteredMerchants.length / MERCHANT_PAGE);
  const maxMerchantTotal = filteredMerchants[0]?.total ?? 1;
  const maxCategoryTotal = aggregates.by_category[0]?.total ?? 1;

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6 pb-20">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="font-serif text-3xl text-gold">Spend</h2>
        <div className="flex items-center gap-3">
          {allData?.last_sync && (
            <span className="text-xs opacity-40">
              Synced {new Date(allData.last_sync).toLocaleDateString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
          <button onClick={recategorize} className="text-xs px-2.5 py-1 border border-line rounded hover:border-gold/60">Re-categorize</button>
          <button onClick={syncBackfill} disabled={syncing}
            className="text-xs px-2.5 py-1 border border-line rounded hover:border-gold/60 disabled:opacity-50"
            title="Fetch all emails going back 5 years (one-time, takes 10–20 min)">
            {syncing ? "…" : "Load full history"}
          </button>
          <button onClick={sync} disabled={syncing}
            className="bg-gold text-ink px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50">
            {syncing ? "Syncing…" : "Sync Gmail"}
          </button>
        </div>
      </div>

      {syncProgress && <div className="text-sm px-3 py-2 rounded border border-gold/30 text-gold/80 font-mono">{syncProgress}</div>}
      {syncResult && !syncProgress && (
        <div className={`text-sm px-3 py-2 rounded border ${syncResult.startsWith("Error") ? "border-red-500 text-red-400" : "border-green-600 text-green-400"}`}>
          {syncResult}
        </div>
      )}

      {/* Filters */}
      <div className="border border-line rounded-lg p-4 space-y-4 bg-panel/30">
        <div className="flex flex-wrap gap-3 items-center">
          <span className="text-xs uppercase tracking-widest opacity-40 w-16">Period</span>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button key={p.label} onClick={() => applyPreset(p)}
                className={`px-2.5 py-1 rounded-md text-xs transition ${activePreset === p.label ? "bg-gold text-ink" : "border border-line hover:border-gold/60"}`}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2 items-center ml-auto">
            <input type="date" value={fromDate}
              onChange={(e) => { setFromDate(e.target.value); setActivePreset("custom"); }}
              className="bg-panel border border-line rounded px-2 py-1 text-xs" />
            <span className="opacity-40 text-xs">→</span>
            <input type="date" value={toDate}
              onChange={(e) => { setToDate(e.target.value); setActivePreset("custom"); }}
              className="bg-panel border border-line rounded px-2 py-1 text-xs" />
          </div>
        </div>

        {allData && allData.cards.length > 0 && (
          <div className="flex gap-3 items-center flex-wrap">
            <span className="text-xs uppercase tracking-widest opacity-40 w-16">Cards</span>
            <div className="flex flex-wrap gap-1.5">
              <button onClick={() => toggleCard("all")}
                className={`px-2.5 py-1 rounded-md text-xs transition ${selectedCards.has("all") ? "bg-gold text-ink" : "border border-line hover:border-gold/60"}`}>
                All
              </button>
              {allData.cards.map((c) => (
                <button key={c.id} onClick={() => toggleCard(c.last4)}
                  className={`px-2.5 py-1 rounded-md text-xs transition ${selectedCards.has(c.last4) ? "bg-gold text-ink" : "border border-line hover:border-gold/60"}`}>
                  {cardLabel(c)} ··{c.last4}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-3 items-center flex-wrap">
          <span className="text-xs uppercase tracking-widest opacity-40 w-16">Type</span>
          <div className="flex gap-1.5">
            {(["all", "debit", "credit"] as const).map((t) => (
              <button key={t} onClick={() => setTxnType(t)}
                className={`px-2.5 py-1 rounded-md text-xs capitalize transition ${txnType === t ? "bg-gold text-ink" : "border border-line hover:border-gold/60"}`}>
                {t}
              </button>
            ))}
          </div>
          {categoryFilter && (
            <div className="ml-auto">
              <button onClick={() => setCategoryFilter(null)}
                className="text-xs opacity-50 hover:opacity-100">clear filter</button>
            </div>
          )}
        </div>

        {categoryFilter && (
          <div className="text-xs text-gold/80">Filtering by category: <span className="font-medium">{categoryFilter}</span></div>
        )}
      </div>

      {loading && !allData && <p className="opacity-50 text-sm">Loading…</p>}

      {allData && filteredTxns.length === 0 && (
        <p className="opacity-50 text-sm">No transactions match these filters. Try widening the period or syncing Gmail.</p>
      )}

      {allData && filteredTxns.length > 0 && (
        <>
          {/* Summary tiles */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Tile label="Total spent"     value={fmt(aggregates.summary.total_debit)}  sub={`${aggregates.summary.debit_count} debits`}    accent="gold" />
            <Tile label="Total refunded"  value={fmt(aggregates.summary.total_credit)} sub={`${aggregates.summary.credit_count} credits`}  accent="green" />
            <Tile label="Net spend"       value={fmt(aggregates.summary.net)}          sub="debits − refunds"                              accent="gold" />
            <Tile label="Transactions"    value={String(aggregates.summary.txn_count)} sub={`${fromDate} to ${toDate}`}                    accent="muted" />
          </div>

          {/* Milestone bars */}
          {txnType !== "credit" && !categoryFilter && (
            <div className="border border-line rounded-lg p-4 space-y-3 bg-panel/30">
              <h3 className="text-xs uppercase tracking-widest opacity-50">Milestones</h3>
              {allData.cards
                .filter((c) => selectedCards.has("all") || selectedCards.has(c.last4))
                .map((card) => {
                  const spent = aggregates.totals[card.last4] || 0;
                  const spec = CARD_REGISTRY[card.product_key];
                  const milestone = spec?.milestones_monthly?.[0]?.spend_inr ?? MILESTONE;
                  const pct = Math.min((spent / milestone) * 100, 100);
                  return (
                    <div key={card.id} className="space-y-1.5">
                      <div className="flex justify-between text-sm">
                        <span>{cardLabel(card)} <span className="opacity-40 text-xs">··{card.last4}</span></span>
                        <span className="text-gold font-medium">{fmt(spent)}</span>
                      </div>
                      <div className="h-1.5 bg-line rounded-full overflow-hidden">
                        <div className="h-full bg-gold rounded-full transition-all" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="flex justify-between text-xs opacity-40">
                        <span>{Math.round(pct)}% to {fmt(milestone)} milestone</span>
                        {pct < 100 ? <span>{fmt(milestone - spent)} to go</span> : <span className="text-green-400">Reached ✓</span>}
                      </div>
                    </div>
                  );
                })}
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-4">
            <div className="border border-line rounded-lg p-4 space-y-3 bg-panel/30">
              <div className="flex items-center justify-between">
                <h3 className="text-xs uppercase tracking-widest opacity-50">By category</h3>
                <span className="text-xs opacity-40">{aggregates.by_category.length} categories</span>
              </div>
              <div className="space-y-2">
                {aggregates.by_category.map((c) => {
                  const isActive = categoryFilter === c.category;
                  return (
                    <button key={c.category} onClick={() => setCategoryFilter(isActive ? null : c.category)}
                      className={`w-full text-left p-2 -m-2 rounded transition ${isActive ? "bg-gold/10" : "hover:bg-white/5"}`}>
                      <div className="flex justify-between items-baseline text-sm">
                        <span className={isActive ? "text-gold" : ""}>{c.category}</span>
                        <span className={isActive ? "text-gold" : "text-gold/80"}>{fmt(c.total)}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <div className="flex-1 h-1 bg-line rounded-full overflow-hidden">
                          <div className="h-full bg-gold/50 rounded-full" style={{ width: `${(c.total / maxCategoryTotal) * 100}%` }} />
                        </div>
                        <span className="text-xs opacity-40 w-12 text-right shrink-0">{c.count} txns</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="border border-line rounded-lg p-4 space-y-3 bg-panel/30">
              <div className="flex items-center justify-between">
                <h3 className="text-xs uppercase tracking-widest opacity-50">By merchant</h3>
                <span className="text-xs opacity-40">
                  {filteredMerchants.length}{filteredMerchants.length !== aggregates.by_merchant.length && ` of ${aggregates.by_merchant.length}`}
                </span>
              </div>
              <div className="flex gap-2 items-center">
                <input type="text" placeholder="Filter merchants…" value={merchantQuery}
                  onChange={(e) => { setMerchantQuery(e.target.value); setMerchantPage(1); }}
                  className="flex-1 bg-panel border border-line rounded px-2 py-1 text-xs focus:border-gold outline-none" />
                <select value={merchantSort} onChange={(e) => setMerchantSort(e.target.value as any)}
                  className="bg-panel border border-line rounded px-2 py-1 text-xs">
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
                <div className="pt-2 border-t border-line flex items-center justify-between">
                  <button onClick={() => { setShowAllMerchants((v) => !v); setMerchantPage(1); }}
                    className="text-xs text-gold/80 hover:text-gold">
                    {showAllMerchants ? "Show top 10" : `Show all ${filteredMerchants.length}`}
                  </button>
                  {showAllMerchants && merchantPageCount > 1 && (
                    <Pager page={merchantPage} count={merchantPageCount} onChange={setMerchantPage} />
                  )}
                </div>
              )}
            </div>
          </div>

          <TransactionsTable
            transactions={filteredTxns}
            cards={allData.cards}
            categories={allCategories}
            existingNotes={existingNotes}
            onMerchantSave={handleMerchantSave}
            onCategoryChange={handleTxnCategoryChange}
            onNotesChange={handleTxnNotesChange}
          />
        </>
      )}
    </div>
  );
}

function Tile({ label, value, sub, accent }: { label: string; value: string; sub: string; accent: "gold" | "green" | "muted" }) {
  const valColor = accent === "gold" ? "text-gold" : accent === "green" ? "text-green-400" : "";
  return (
    <div className="border border-line rounded-lg p-3 bg-panel/30">
      <div className="text-xs opacity-50">{label}</div>
      <div className={`text-2xl font-medium mt-1 ${valColor}`}>{value}</div>
      <div className="text-xs opacity-40 mt-1">{sub}</div>
    </div>
  );
}

function Pager({ page, count, onChange }: { page: number; count: number; onChange: (p: number) => void }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <button disabled={page <= 1} onClick={() => onChange(page - 1)}
        className="px-2 py-1 border border-line rounded disabled:opacity-30 hover:border-gold/60">‹</button>
      <span className="opacity-60">Page {page} of {count}</span>
      <button disabled={page >= count} onClick={() => onChange(page + 1)}
        className="px-2 py-1 border border-line rounded disabled:opacity-30 hover:border-gold/60">›</button>
    </div>
  );
}
