"use client";

import { useEffect, useMemo, useState } from "react";
import { useTransactionsAll, refreshTransactionsAll, patchTransactionsAll } from "@/lib/transactions-cache";
import { CARD_REGISTRY } from "@/lib/cards/registry";
import { CATEGORIES, SUBCATEGORIES } from "@/lib/categories";
import { ymd } from "@/lib/format";
import {
  buildSpendSearchContext,
  filterSpendTransactions,
  summarizeSpendTransactions,
} from "@/lib/spend-filter";
import SpendBreakdowns   from "./SpendBreakdowns";
import SpendFilterPanel  from "./SpendFilterPanel";
import SyncPanel         from "./SyncPanel";
import TransactionsTable, { type OrderRow, type CategoryPatch } from "./TransactionsTable";
import ForeignCurrencyPanel from "./ForeignCurrencyPanel";

// ── Types ───────────────────────────────────────────────────────
type Txn = {
  id: string; card_last4: string; amount_inr: number;
  original_currency: string | null;
  original_amount:   number | null;
  merchant: string | null; category: string | null;
  subcategory?: string | null;
  txn_at: string; txn_type: "debit" | "credit"; notes?: string | null;
};
type CardRow = { id: string; last4: string; nickname: string | null; product_key: string };
type OrderApiRow = OrderRow & { txn_id: string | null };
type VoucherApiRow = { id: string; brand: string; brand_key: string; face_value: number | string; txn_id: string | null };
type AllData = { transactions: Txn[]; orders?: OrderApiRow[]; vouchers?: VoucherApiRow[]; cards: CardRow[]; last_sync: string | null };

// ── Utils ────────────────────────────────────────────────────────────────────
const fmt  = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
const cardLabel = (c: CardRow) => c.nickname || CARD_REGISTRY[c.product_key]?.display_name || c.product_key;
const cardSearchLabel = (c: CardRow) =>
  [c.nickname, CARD_REGISTRY[c.product_key]?.display_name, c.product_key]
    .filter(Boolean)
    .join(" ");

function amountBoundary(value: string): number | null {
  if (!value.trim()) return null;
  return Number(value);
}

function defaultRange() {
  const d = new Date();
  return {
    from: ymd(new Date(d.getFullYear(), d.getMonth(), 1)),
    to:   ymd(d),
  };
}

// ── Component ────────────────────────────────────────────────────────────────
// `focusCard` is a deep-link from Overview card tiles: a fresh object per click
// (identity change re-fires the effect even for the same card).
export default function SpendTab({ focusCard }: { focusCard?: { last4: string } | null }) {
  const [initialRange] = useState(defaultRange);
  const init = initialRange;
  const [fromDate, setFromDate] = useState(init.from);
  const [toDate,   setToDate]   = useState(init.to);
  const [selectedCards, setSelectedCards] = useState<Set<string>>(new Set(["all"]));
  const [txnType, setTxnType]   = useState<"all" | "debit" | "credit">("all");
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [subcategoryFilter, setSubcategoryFilter] = useState<string | null>(null);
  const [merchantFilter, setMerchantFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [amountMin, setAmountMin] = useState("");
  const [amountMax, setAmountMax] = useState("");

  const { data: rawAllData, loading } = useTransactionsAll();
  const allData = rawAllData as AllData | null;
  const [recat,    setRecat]    = useState<string | null>(null);

  useEffect(() => {
    if (focusCard) setSelectedCards(new Set([focusCard.last4]));
  }, [focusCard]);

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

  function resetFilters() {
    const range = defaultRange();
    setFromDate(range.from);
    setToDate(range.to);
    setSelectedCards(new Set(["all"]));
    setTxnType("all");
    setCategoryFilter(null);
    setSubcategoryFilter(null);
    setMerchantFilter(null);
    setSearch("");
    setAmountMin("");
    setAmountMax("");
  }

  async function recategorize() {
    setRecat("Re-categorizing…");
    const res  = await fetch("/api/recategorize", { method: "POST" });
    const json = await res.json();
    setRecat(res.ok ? `✓ Re-categorized ${json.updated}/${json.total} transactions` : `Error: ${json.error}`);
    if (res.ok) refreshTransactionsAll();
  }

  async function handleMerchantSave(old_name: string, new_name: string, category: string, subcategory: string | null) {
    const res = await fetch("/api/merchant-mappings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ old_name, new_name, category, subcategory }),
    });
    if (!res.ok) return;
    if (merchantFilter === old_name) setMerchantFilter(new_name);
    patchTransactionsAll((prev) => ({
      ...prev,
      transactions: (prev.transactions as Txn[]).map((t) =>
        t.merchant === old_name ? { ...t, merchant: new_name, category, subcategory } : t
      ),
    }));
  }

  async function handleTxnCategoryChange(txnId: string, patch: CategoryPatch) {
    const res = await fetch(`/api/transactions/${txnId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return;
    patchTransactionsAll((prev) => ({
      ...prev,
      transactions: (prev.transactions as Txn[]).map((t) =>
        t.id === txnId
          ? {
              ...t,
              ...(patch.category !== undefined ? { category: patch.category } : {}),
              ...(patch.subcategory !== undefined ? { subcategory: patch.subcategory } : {}),
            }
          : t
      ),
    }));
  }

  async function handleTxnNotesChange(txnId: string, notes: string) {
    const res = await fetch(`/api/transactions/${txnId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    });
    if (!res.ok) return;
    patchTransactionsAll((prev) => ({
      ...prev,
      transactions: (prev.transactions as Txn[]).map((t) => t.id === txnId ? { ...t, notes } : t),
    }));
  }

  async function handleNotesBulk(merchant: string, notes: string) {
    const res = await fetch("/api/transactions/bulk-notes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ merchant, notes }),
    });
    if (!res.ok) return;
    patchTransactionsAll((prev) => ({
      ...prev,
      transactions: (prev.transactions as Txn[]).map((t) => t.merchant === merchant ? { ...t, notes } : t),
    }));
  }

  // ── Memos ──────────────────────────────────────────────────────────────────
  const allCategories = useMemo(() => {
    const set = new Set<string>(CATEGORIES);
    for (const t of allData?.transactions ?? []) {
      if (t.category?.trim()) set.add(t.category.trim());
    }
    return Array.from(set);
  }, [allData]);

  const allMerchants = useMemo(() => {
    const set = new Set<string>();
    for (const t of allData?.transactions ?? []) set.add(t.merchant?.trim() || "(missing)");
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allData]);

  const existingNotes = useMemo(() => {
    const set = new Set<string>();
    for (const t of allData?.transactions ?? []) {
      if (t.notes?.trim()) set.add(t.notes.trim());
    }
    return Array.from(set);
  }, [allData]);

  // Subcategory suggestions per category: canonical list (SUBCATEGORIES) +
  // anything the user has already typed on a transaction in that category —
  // same "custom values resurface" behaviour as categories.
  const subcategorySuggestions = useMemo(() => {
    const map: Record<string, Set<string>> = {};
    for (const [cat, subs] of Object.entries(SUBCATEGORIES)) map[cat] = new Set(subs);
    for (const t of allData?.transactions ?? []) {
      const cat = t.category?.trim();
      const sub = t.subcategory?.trim();
      if (!cat || !sub) continue;
      (map[cat] ??= new Set()).add(sub);
    }
    return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, Array.from(v)]));
  }, [allData]);

  const filterSubcategories = useMemo(() => {
    const set = new Set<string>();
    if (categoryFilter) {
      for (const value of subcategorySuggestions[categoryFilter] ?? []) set.add(value);
    } else {
      for (const values of Object.values(subcategorySuggestions)) {
        for (const value of values) set.add(value);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [categoryFilter, subcategorySuggestions]);

  // Matched order emails keyed by transaction id (expand-row enrichment).
  const ordersByTxn = useMemo(() => {
    const map = new Map<string, OrderRow>();
    for (const o of allData?.orders ?? []) {
      if (o.txn_id) map.set(o.txn_id, o);
    }
    return map;
  }, [allData]);

  // Vouchers a charge funded, keyed by that funding txn id — lets a GYFTR row
  // show the brand it bought ("Gyftr → Pure Home + Living"). One charge can buy
  // several brands/denominations in one go, so it's a list.
  const vouchersByTxn = useMemo(() => {
    const map = new Map<string, { brand: string; face_value: number }[]>();
    for (const v of allData?.vouchers ?? []) {
      if (!v.txn_id) continue;
      const list = map.get(v.txn_id) ?? [];
      list.push({ brand: v.brand, face_value: Number(v.face_value) });
      map.set(v.txn_id, list);
    }
    return map;
  }, [allData]);

  const searchContext = useMemo(() => buildSpendSearchContext(
    allData?.transactions ?? [],
    (allData?.cards ?? []).map((card) => ({ last4: card.last4, label: cardSearchLabel(card) })),
    ordersByTxn,
    vouchersByTxn,
  ), [allData, ordersByTxn, vouchersByTxn]);

  const minAmount = amountBoundary(amountMin);
  const maxAmount = amountBoundary(amountMax);
  const amountError =
    (minAmount !== null && (!Number.isFinite(minAmount) || minAmount < 0)) ||
    (maxAmount !== null && (!Number.isFinite(maxAmount) || maxAmount < 0))
      ? "Amounts must be zero or more."
      : minAmount !== null && maxAmount !== null && minAmount > maxAmount
        ? "Minimum cannot exceed maximum."
        : null;

  const filteredTxns = useMemo(() => {
    if (!allData) return [];
    return filterSpendTransactions(allData.transactions, {
      from: fromDate,
      to: toDate,
      selectedCards,
      txnType,
      category: categoryFilter,
      subcategory: subcategoryFilter,
      merchant: merchantFilter,
      search,
      amountMin: minAmount,
      amountMax: maxAmount,
      searchContext,
    });
  }, [
    allData,
    fromDate,
    toDate,
    selectedCards,
    txnType,
    categoryFilter,
    subcategoryFilter,
    merchantFilter,
    search,
    minAmount,
    maxAmount,
    searchContext,
  ]);
  const filterKey = [
    fromDate,
    toDate,
    [...selectedCards].sort().join(","),
    txnType,
    categoryFilter ?? "",
    subcategoryFilter ?? "",
    merchantFilter ?? "",
    search,
    amountMin,
    amountMax,
  ].join("|");

  // This same filtered array feeds the totals, table, and compact breakdown.
  const aggregates = useMemo(() => summarizeSpendTransactions(filteredTxns), [filteredTxns]);
  const { inrTxns, foreignTxns } = aggregates;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-6 pb-20">

      <SpendFilterPanel
        search={search}
        onSearchChange={setSearch}
        from={fromDate}
        to={toDate}
        onPeriodChange={(from, to) => { setFromDate(from); setToDate(to); }}
        merchant={merchantFilter}
        merchants={allMerchants}
        onMerchantChange={setMerchantFilter}
        category={categoryFilter}
        categories={allCategories}
        onCategoryChange={(value) => {
          setCategoryFilter(value);
          if (value && subcategoryFilter && !(subcategorySuggestions[value] ?? []).includes(subcategoryFilter)) {
            setSubcategoryFilter(null);
          }
        }}
        subcategory={subcategoryFilter}
        subcategories={filterSubcategories}
        onSubcategoryChange={setSubcategoryFilter}
        amountMin={amountMin}
        amountMax={amountMax}
        onAmountMinChange={setAmountMin}
        onAmountMaxChange={setAmountMax}
        amountError={amountError}
        selectedCards={selectedCards}
        cards={(allData?.cards ?? []).map((card) => ({
          id: card.id,
          last4: card.last4,
          label: cardLabel(card),
        }))}
        onToggleCard={toggleCard}
        txnType={txnType}
        onTxnTypeChange={setTxnType}
        resultCount={filteredTxns.length}
        onReset={resetFilters}
      />

      {loading && !allData && (
        <div className="flex items-center justify-center py-16 text-mist/55 text-sm">Loading…</div>
      )}

      {allData && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatTile
            label="Total spend"
            value={fmt(aggregates.summary.total_debit)}
            sub={`${aggregates.summary.debit_count} INR spend${aggregates.summary.debit_count === 1 ? "" : "s"}`}
            accent="gold"
          />
          <StatTile
            label="Refunded"
            value={fmt(aggregates.summary.total_credit)}
            sub={`${aggregates.summary.credit_count} INR refund${aggregates.summary.credit_count === 1 ? "" : "s"}`}
            accent="emerald"
          />
          <StatTile
            label="Net spend"
            value={fmt(aggregates.summary.net)}
            sub="spends − refunds"
            accent="gold"
          />
          <StatTile
            label="Results"
            value={String(filteredTxns.length)}
            sub={foreignTxns.length > 0
              ? `${inrTxns.length} INR · ${foreignTxns.length} foreign`
              : `${inrTxns.length} INR transaction${inrTxns.length === 1 ? "" : "s"}`}
            accent="muted"
          />
        </div>
      )}

      {allData && filteredTxns.length === 0 && (
        <div className="rounded-2xl border border-rim bg-surface text-center py-12 px-5 text-mist/55 text-sm">
          No transactions match these filters. Try removing one filter or widening the period.
        </div>
      )}

      {allData && filteredTxns.length > 0 && (
        <>
          {inrTxns.length > 0 && (
            <TransactionsTable
              resultKey={filterKey}
              transactions={inrTxns}
              cards={allData.cards}
              categories={allCategories}
              subcategories={subcategorySuggestions}
              ordersByTxn={ordersByTxn}
              vouchersByTxn={vouchersByTxn}
              existingNotes={existingNotes}
              onMerchantSave={handleMerchantSave}
              onCategoryChange={handleTxnCategoryChange}
              onNotesChange={handleTxnNotesChange}
              onNotesBulk={handleNotesBulk}
            />
          )}

          {/* ── Foreign currency panel (renders only if foreign txns exist) ── */}
          <ForeignCurrencyPanel transactions={foreignTxns} />

          {(aggregates.by_category.length > 0 || aggregates.by_merchant.length > 0) && (
            <SpendBreakdowns
              categories={aggregates.by_category}
              merchants={aggregates.by_merchant}
              categoryFilter={categoryFilter}
              onCategoryFilter={(value) => {
                setCategoryFilter(value);
                setSubcategoryFilter(null);
              }}
              allCategories={allCategories}
              subcategories={subcategorySuggestions}
              onMerchantSave={handleMerchantSave}
            />
          )}
        </>
      )}

      <section className="rounded-2xl border border-rim bg-surface px-5 py-4 shadow-card">
        <details>
          <summary className="cursor-pointer list-none flex items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-medium text-mist/75">Update spend data</h2>
              <p className="text-2xs text-mist/40 mt-0.5">Gmail sync and re-categorization tools</p>
            </div>
            <span className="text-xs text-gold/60">Open tools ▾</span>
          </summary>
          <div className="pt-4 mt-4 border-t border-wire">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <p className="text-xs text-mist/55">
                Emails are read once and their transaction data is stored locally.
              </p>
              <button
                type="button"
                onClick={recategorize}
                className="text-xs text-mist/60 hover:text-gold transition-colors whitespace-nowrap"
              >
                Re-categorize
              </button>
            </div>
            <div className="mt-4">
              <SyncPanel onSyncComplete={refreshTransactionsAll} />
            </div>
            {recat && (
              <div className={`mt-3 text-xs px-3 py-2 rounded-lg border ${
                recat.startsWith("✓")
                  ? "border-emerald/30 bg-emerald/5 text-emerald"
                  : "border-ruby/30 bg-ruby/5 text-ruby"
              }`}>
                {recat}
              </div>
            )}
          </div>
        </details>
      </section>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatTile({ label, value, sub, accent }: {
  label: string; value: string; sub: string; accent: "gold" | "emerald" | "muted";
}) {
  const valClass = accent === "gold" ? "text-gold" : accent === "emerald" ? "text-emerald" : "text-mist/80";
  return (
    <div className="rounded-2xl border border-rim bg-surface p-4 shadow-card">
      <div className="text-2xs uppercase tracking-widest text-mist/55 mb-2">{label}</div>
      <div className={`font-serif text-2xl font-semibold tabular-nums ${valClass}`}>{value}</div>
      <div className="text-2xs text-mist/55 mt-1">{sub}</div>
    </div>
  );
}
