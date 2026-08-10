"use client";

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
  return (
    <section className="rounded-2xl border border-gold/20 bg-surface p-5 shadow-card space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-serif text-lg font-semibold text-gold">Explore your spending</h2>
          <p className="text-xs text-mist/55 mt-1">
            Every filter updates the totals, breakdowns, and transactions together.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-mist/55 tabular-nums">
            {resultCount.toLocaleString("en-IN")} result{resultCount === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            onClick={onReset}
            className="text-xs px-2.5 py-1.5 rounded-lg border border-rim text-mist/60 hover:text-gold hover:border-gold/30 transition-colors"
          >
            Reset all
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 gap-3">
        <label className="lg:col-span-5">
          <FieldLabel>Search everything</FieldLabel>
          <div className="relative">
            <svg
              aria-hidden="true"
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-mist/35"
              fill="none"
              viewBox="0 0 16 16"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <circle cx="7" cy="7" r="4.5" />
              <path d="m10.5 10.5 3 3" />
            </svg>
            <input
              type="search"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Merchant, card, amount, note, item…"
              className={`${controlClass} pl-9`}
            />
          </div>
          <span className="block text-2xs text-mist/40 mt-1">
            Try “pickleball”, “HDFC”, “Amazon” or “4,181”
          </span>
        </label>

        <div className="lg:col-span-3">
          <FieldLabel>Period</FieldLabel>
          <PeriodPicker from={from} to={to} onChange={onPeriodChange} />
        </div>

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
      </div>

      {cards.length > 0 && (
        <div className="pt-4 border-t border-wire">
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
    </section>
  );
}
