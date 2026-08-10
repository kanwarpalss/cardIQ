"use client";

import { useEffect, useMemo, useState } from "react";
import MerchantPanel from "./MerchantPanel";

type CategoryRow = {
  category: string;
  total: number;
  count: number;
};

type MerchantRow = {
  merchant: string;
  total: number;
  count: number;
  category: string;
  subcategory: string | null;
};

interface Props {
  categories: CategoryRow[];
  merchants: MerchantRow[];
  categoryFilter: string | null;
  onCategoryFilter: (value: string | null) => void;
  allCategories: string[];
  subcategories: Record<string, string[]>;
  onMerchantSave: (
    oldName: string,
    newName: string,
    category: string,
    subcategory: string | null
  ) => Promise<void>;
}

const PAGE_SIZE = 8;
const fmt = (value: number) => "₹" + Math.round(value).toLocaleString("en-IN");

function Pager({ page, count, onChange }: {
  page: number;
  count: number;
  onChange: (page: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
        className="px-2 py-1 rounded border border-rim hover:border-gold/30 disabled:opacity-20 transition-all"
      >
        ‹
      </button>
      <span className="text-mist/60 tabular-nums">{page}/{count}</span>
      <button
        type="button"
        disabled={page >= count}
        onClick={() => onChange(page + 1)}
        className="px-2 py-1 rounded border border-rim hover:border-gold/30 disabled:opacity-20 transition-all"
      >
        ›
      </button>
    </div>
  );
}

export default function SpendBreakdowns({
  categories,
  merchants,
  categoryFilter,
  onCategoryFilter,
  allCategories,
  subcategories,
  onMerchantSave,
}: Props) {
  const [view, setView] = useState<"category" | "merchant">("category");
  const [sort, setSort] = useState<"total" | "count" | "name">("total");
  const [categoryPage, setCategoryPage] = useState(1);
  const [merchantPage, setMerchantPage] = useState(1);

  useEffect(() => {
    setCategoryPage(1);
    setMerchantPage(1);
  }, [categories, merchants]);

  const sortedCategories = useMemo(() => [...categories].sort((a, b) => {
    if (sort === "name") return a.category.localeCompare(b.category);
    if (sort === "count") return b.count - a.count;
    return b.total - a.total;
  }), [categories, sort]);

  const sortedMerchants = useMemo(() => [...merchants].sort((a, b) => {
    if (sort === "name") return a.merchant.localeCompare(b.merchant);
    if (sort === "count") return b.count - a.count;
    return b.total - a.total;
  }), [merchants, sort]);

  const categoryPageCount = Math.max(1, Math.ceil(sortedCategories.length / PAGE_SIZE));
  const merchantPageCount = Math.max(1, Math.ceil(sortedMerchants.length / PAGE_SIZE));
  const safeCategoryPage = Math.min(categoryPage, categoryPageCount);
  const safeMerchantPage = Math.min(merchantPage, merchantPageCount);
  const visibleCategories = sortedCategories.slice(
    (safeCategoryPage - 1) * PAGE_SIZE,
    safeCategoryPage * PAGE_SIZE
  );
  const visibleMerchants = sortedMerchants.slice(
    (safeMerchantPage - 1) * PAGE_SIZE,
    safeMerchantPage * PAGE_SIZE
  );
  const maxCategoryTotal = sortedCategories[0]?.total ?? 1;
  const maxMerchantTotal = sortedMerchants[0]?.total ?? 1;

  return (
    <section className="rounded-2xl border border-rim bg-surface p-4 shadow-card space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div>
            <h3 className="text-2xs uppercase tracking-widest text-mist/55">Breakdown</h3>
            <p className="text-2xs text-mist/35 mt-0.5">A compact lens over the same filtered results</p>
          </div>
          <div className="flex p-0.5 rounded-lg border border-rim bg-ink" role="group" aria-label="Breakdown type">
            <button
              type="button"
              aria-pressed={view === "category"}
              onClick={() => setView("category")}
              className={`px-2.5 py-1 rounded-md text-xs transition-colors ${
                view === "category" ? "bg-raised text-gold" : "text-mist/45 hover:text-mist/70"
              }`}
            >
              Categories <span className="opacity-45">{sortedCategories.length}</span>
            </button>
            <button
              type="button"
              aria-pressed={view === "merchant"}
              onClick={() => setView("merchant")}
              className={`px-2.5 py-1 rounded-md text-xs transition-colors ${
                view === "merchant" ? "bg-raised text-gold" : "text-mist/45 hover:text-mist/70"
              }`}
            >
              Merchants <span className="opacity-45">{sortedMerchants.length}</span>
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select
            aria-label={`Sort ${view} breakdown`}
            value={sort}
            onChange={(event) => setSort(event.target.value as typeof sort)}
            className="bg-ink border border-rim rounded-lg px-2 py-1.5 text-xs text-mist/65 focus:border-gold/40 outline-none"
          >
            <option value="total">Highest spend</option>
            <option value="count">Most transactions</option>
            <option value="name">A–Z</option>
          </select>
          {view === "category" && categoryPageCount > 1 && (
            <Pager page={safeCategoryPage} count={categoryPageCount} onChange={setCategoryPage} />
          )}
          {view === "merchant" && merchantPageCount > 1 && (
            <Pager page={safeMerchantPage} count={merchantPageCount} onChange={setMerchantPage} />
          )}
        </div>
      </div>

      <div className="pt-3 border-t border-wire">
        {view === "category" ? (
          visibleCategories.length === 0 ? (
            <p className="text-xs text-mist/40 py-5 text-center">No INR spends in these results.</p>
          ) : (
            <div className="grid sm:grid-cols-2 gap-x-6">
              {visibleCategories.map((row) => {
                const active = categoryFilter === row.category;
                return (
                  <button
                    type="button"
                    key={row.category}
                    aria-pressed={active}
                    onClick={() => onCategoryFilter(active ? null : row.category)}
                    className={`text-left py-2 px-2 rounded-lg transition-colors ${
                      active ? "bg-gold/8" : "hover:bg-raised"
                    }`}
                  >
                    <div className="flex items-center gap-3 text-xs">
                      <span className={`truncate min-w-0 flex-1 ${active ? "text-gold" : "text-mist/70"}`}>
                        {row.category}
                      </span>
                      <span className="text-mist/35 tabular-nums">{row.count}×</span>
                      <span className={`font-medium tabular-nums ${active ? "text-gold" : "text-mist/65"}`}>
                        {fmt(row.total)}
                      </span>
                    </div>
                    <div className="h-px bg-ink mt-1.5 overflow-hidden">
                      <div
                        className="h-full bg-gold/45"
                        style={{ width: `${(row.total / maxCategoryTotal) * 100}%` }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          )
        ) : visibleMerchants.length === 0 ? (
          <p className="text-xs text-mist/40 py-5 text-center">No INR spends in these results.</p>
        ) : (
          <MerchantPanel
            merchants={visibleMerchants}
            maxTotal={maxMerchantTotal}
            categories={allCategories}
            subcategories={subcategories}
            onSave={onMerchantSave}
          />
        )}
      </div>
    </section>
  );
}
