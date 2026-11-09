"use client";

import { useState } from "react";
import PeriodPicker from "./PeriodPicker";

export type SpendCardOption = {
  id: string;
  last4: string;
  label: string;
};

type TxnType = "all" | "debit" | "credit";

interface Props {
  search: string;
  onSearchChange: (value: string) => void;
  from: string;
  to: string;
  onPeriodChange: (from: string, to: string) => void;
  merchant: string | null;
  merchants: string[];
  onMerchantChange: (value: string | null) => void;
  category: string | null;
  categories: string[];
  onCategoryChange: (value: string | null) => void;
  subcategory: string | null;
  subcategories: string[];
  onSubcategoryChange: (value: string | null) => void;
  amountMin: string;
  amountMax: string;
  onAmountMinChange: (value: string) => void;
  onAmountMaxChange: (value: string) => void;
  amountError: string | null;
  selectedCards: ReadonlySet<string>;
  cards: SpendCardOption[];
  onToggleCard: (last4: string) => void;
  txnType: TxnType;
  onTxnTypeChange: (value: TxnType) => void;
  resultCount: number;
  onReset: () => void;
}

const controlClass =
  "w-full bg-ink border border-rim rounded-lg px-3 py-2 text-sm text-mist placeholder:text-mist/30 focus:border-gold/50 focus:ring-1 focus:ring-gold/15 outline-none transition-colors";

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="block text-2xs uppercase tracking-widest text-mist/55 mb-1.5">
      {children}
    </span>
  );
}

function FilterPill({ active, onClick, children }: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
        active
          ? "bg-gold text-ink shadow-glow-gold"
          : "bg-raised border border-rim hover:border-gold/30 text-mist/60 hover:text-mist"
      }`}
    >
      {children}
    </button>
  );
}

export default function SpendFilterPanel({
  search,
  onSearchChange,
  from,
  to,
  onPeriodChange,
  merchant,
  merchants,
  onMerchantChange,
  category,
  categories,
  onCategoryChange,
  subcategory,
  subcategories,
  onSubcategoryChange,
  amountMin,
  amountMax,
  onAmountMinChange,
  onAmountMaxChange,
  amountError,
  selectedCards,
  cards,
  onToggleCard,
  txnType,
  onTxnTypeChange,
  resultCount,
  onReset,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const activeFilters = [merchant, category, subcategory, amountMin, amountMax,
    txnType !== "all", !selectedCards.has("all")].filter(Boolean).length;
  return (
    <section aria-label="Spending filters" className="spend-filters rounded-2xl border border-wire bg-surface p-4 shadow-card space-y-3">
      <div className="compact-filter-toolbar">
        <label className="filter-search min-w-0">
          <span className="sr-only">Search everything</span>
          <div className="relative">
            <svg aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-mist/35" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5}><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
            <input type="search" value={search} onChange={event => onSearchChange(event.target.value)} placeholder="Merchant, card, note, item…" className={`${controlClass} pl-9`} />
          </div>
        </label>
        <div className="filter-period"><span className="sr-only">Period</span><PeriodPicker from={from} to={to} onChange={onPeriodChange} /></div>
        <button type="button" className="filter-disclosure" aria-expanded={expanded} aria-controls="spend-refinements" onClick={() => setExpanded(value => !value)}>
          <span>Filters{activeFilters > 0 ? ` · ${activeFilters} active` : ""}</span><span aria-hidden="true">{expanded ? "−" : "+"}</span>
        </button>
        <button type="button" onClick={onReset} className="filter-reset text-xs text-mist/60 rounded-lg px-2">Reset all</button>
      </div>
      <p className="text-xs text-mist/60" role="status">{resultCount.toLocaleString("en-IN")} result{resultCount === 1 ? "" : "s"}</p>
      {!expanded && activeFilters > 0 && <p className="text-xs text-mist/65" aria-label="Active spend filters">{[
        merchant && `Merchant: ${merchant}`, category && `Category: ${category}`, subcategory && `Subcategory: ${subcategory}`,
        amountMin && `Min ₹${amountMin}`, amountMax && `Max ₹${amountMax}`, txnType !== "all" && (txnType === "debit" ? "Spends only" : "Refunds only"),
        !selectedCards.has("all") && `Cards: ${cards.filter(c => selectedCards.has(c.last4)).map(c => `${c.label} ··${c.last4}`).join(", ") || "none selected"}`,
      ].filter(Boolean).join(" · ")}</p>}
      {amountError && !expanded && <p className="text-xs text-ruby" role="alert">{amountError}</p>}
      <div id="spend-refinements" className={`${expanded ? "grid" : "hidden"} grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-3 border-t border-wire pt-4`}>
        <label className="lg:col-span-4">
          <FieldLabel>Merchant</FieldLabel>
          <select
            value={merchant ?? ""}
            onChange={(event) => onMerchantChange(event.target.value || null)}
            className={controlClass}
          >
            <option value="">All merchants</option>
            {merchants.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>

        <label className="lg:col-span-3">
          <FieldLabel>Category</FieldLabel>
          <select
            value={category ?? ""}
            onChange={(event) => onCategoryChange(event.target.value || null)}
            className={controlClass}
          >
            <option value="">All categories</option>
            {categories.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>

        <label className="lg:col-span-3">
          <FieldLabel>Subcategory</FieldLabel>
          <select
            value={subcategory ?? ""}
            onChange={(event) => onSubcategoryChange(event.target.value || null)}
            className={controlClass}
          >
            <option value="">All subcategories</option>
            {subcategories.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>

        <div className="lg:col-span-3">
          <FieldLabel>Amount range</FieldLabel>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              aria-label="Minimum transaction amount"
              placeholder="Min ₹"
              value={amountMin}
              onChange={(event) => onAmountMinChange(event.target.value)}
              className={controlClass}
            />
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              aria-label="Maximum transaction amount"
              placeholder="Max ₹"
              value={amountMax}
              onChange={(event) => onAmountMaxChange(event.target.value)}
              className={controlClass}
            />
          </div>
          {amountError && (
            <span className="block text-2xs text-ruby mt-1" role="alert">{amountError}</span>
          )}
        </div>

        <div className="lg:col-span-3">
          <FieldLabel>Transaction type</FieldLabel>
          <div className="flex gap-1.5 flex-wrap">
            {(["all", "debit", "credit"] as const).map((value) => (
              <FilterPill
                key={value}
                active={txnType === value}
                onClick={() => onTxnTypeChange(value)}
              >
                {value === "all" ? "All" : value === "debit" ? "Spends" : "Refunds"}
              </FilterPill>
            ))}
          </div>
        </div>
      {cards.length > 0 && (
        <div className="sm:col-span-2 lg:col-span-12 pt-3 border-t border-wire">
          <FieldLabel>Cards</FieldLabel>
          <div className="flex flex-wrap gap-1.5">
            <FilterPill active={selectedCards.has("all")} onClick={() => onToggleCard("all")}>
              All cards
            </FilterPill>
            {cards.map((card) => (
              <FilterPill
                key={card.id}
                active={selectedCards.has(card.last4)}
                onClick={() => onToggleCard(card.last4)}
              >
                {card.label} <span className="opacity-50 font-normal">··{card.last4}</span>
              </FilterPill>
            ))}
          </div>
        </div>
      )}
      </div>
    </section>
  );
}
