export type SpendFilterTxn = {
  id: string;
  card_last4: string;
  amount_inr: number;
  merchant: string | null;
  txn_at: string;
  txn_type: "debit" | "credit";
  category: string | null;
  subcategory?: string | null;
  notes?: string | null;
  original_currency?: string | null;
};

export type SpendFilters = {
  from: string;
  to: string;
  selectedCards: ReadonlySet<string>;
  txnType: "all" | "debit" | "credit";
  category: string | null;
  subcategory: string | null;
  merchant: string | null;
  search: string;
  amountMin: number | null;
  amountMax: number | null;
  /** Order items, voucher brands, and card display names keyed by txn id. */
  searchContext?: ReadonlyMap<string, string>;
};

type SpendSearchCard = {
  last4: string;
  label: string;
};

type SpendSearchOrder = {
  source: string;
  order_ref: string | null;
  merchant_name: string | null;
  total_amount: number | string | null;
  items: Array<{ name: string; qty?: number; price?: number }>;
};

type SpendSearchVoucher = {
  brand: string;
  face_value: number;
};

function localDay(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : null;
}

function normalizeSearch(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-IN")
    .replace(/\s+/g, " ")
    .trim();
}

function searchableAmount(amount: number): string {
  const exact = amount.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  const rounded = Math.round(amount).toLocaleString("en-IN");
  return `${amount} ${exact} ${rounded} ₹${exact} ₹${rounded}`;
}

function invalidBoundary(value: number | null): boolean {
  return value !== null && (!Number.isFinite(value) || value < 0);
}

/** Build the non-transaction text searched by the unified Spend search box. */
export function buildSpendSearchContext(
  transactions: ReadonlyArray<Pick<SpendFilterTxn, "id" | "card_last4">>,
  cards: ReadonlyArray<SpendSearchCard>,
  ordersByTxn: ReadonlyMap<string, SpendSearchOrder>,
  vouchersByTxn: ReadonlyMap<string, SpendSearchVoucher[]>
): Map<string, string> {
  const cardLabels = new Map(cards.map((card) => [card.last4, card.label]));
  const context = new Map<string, string>();

  for (const txn of transactions) {
    const order = ordersByTxn.get(txn.id);
    const vouchers = vouchersByTxn.get(txn.id) ?? [];
    context.set(txn.id, [
      cardLabels.get(txn.card_last4),
      order?.source,
      order?.merchant_name,
      order?.order_ref,
      order?.total_amount,
      ...(order?.items.flatMap((item) => [item.name, item.qty, item.price]) ?? []),
      ...vouchers.flatMap((voucher) => [voucher.brand, voucher.face_value]),
    ].filter((value) => value !== null && value !== undefined && value !== "").join(" "));
  }
  return context;
}

/** Apply every Spend control as an AND filter over one canonical result set. */
export function filterSpendTransactions<T extends SpendFilterTxn>(
  transactions: T[],
  filters: SpendFilters
): T[] {
  const from = localDay(filters.from);
  const to = localDay(filters.to);
  if (!from || !to || from.getTime() > to.getTime()) return [];
  if (invalidBoundary(filters.amountMin) || invalidBoundary(filters.amountMax)) return [];
  if (
    filters.amountMin !== null &&
    filters.amountMax !== null &&
    filters.amountMin > filters.amountMax
  ) return [];

  const toExclusive = new Date(to);
  toExclusive.setDate(toExclusive.getDate() + 1);
  const selected = filters.selectedCards.has("all") ? null : filters.selectedCards;
  const searchTerms = normalizeSearch(filters.search).split(" ").filter(Boolean);

  return transactions.filter((txn) => {
    if (!/([zZ]|[+-]\d{2}:\d{2})$/.test(txn.txn_at)) return false;
    const at = new Date(txn.txn_at).getTime();
    const amount = Number(txn.amount_inr);
    if (!Number.isFinite(at) || at < from.getTime() || at >= toExclusive.getTime()) return false;
    if (!Number.isFinite(amount) || amount < 0) return false;
    if (selected && !selected.has(txn.card_last4)) return false;
    if (filters.txnType !== "all" && txn.txn_type !== filters.txnType) return false;
    if (filters.category && (txn.category || "Uncategorized") !== filters.category) return false;
    if (filters.subcategory && txn.subcategory !== filters.subcategory) return false;
    if (filters.merchant && (txn.merchant || "(missing)") !== filters.merchant) return false;
    if (filters.amountMin !== null && amount < filters.amountMin) return false;
    if (filters.amountMax !== null && amount > filters.amountMax) return false;

    if (searchTerms.length > 0) {
      const haystack = normalizeSearch([
        txn.merchant || "(missing)",
        txn.category || "Uncategorized",
        txn.subcategory,
        txn.notes,
        txn.card_last4,
        searchableAmount(amount),
        filters.searchContext?.get(txn.id),
      ].filter(Boolean).join(" "));
      if (!searchTerms.every((term) => haystack.includes(term))) return false;
    }
    return true;
  });
}

export function summarizeSpendTransactions<T extends SpendFilterTxn>(transactions: T[]) {
  const inrTxns: T[] = [];
  const foreignTxns: T[] = [];
  for (const txn of transactions) {
    const currency = txn.original_currency?.trim().toUpperCase();
    if (!currency || currency === "INR") inrTxns.push(txn);
    else foreignTxns.push(txn);
  }

  const debits = inrTxns.filter((txn) => txn.txn_type === "debit");
  const credits = inrTxns.filter((txn) => txn.txn_type === "credit");
  const totalDebit = debits.reduce((sum, txn) => sum + Number(txn.amount_inr), 0);
  const totalCredit = credits.reduce((sum, txn) => sum + Number(txn.amount_inr), 0);

  const merchantMap: Record<
    string,
    { total: number; count: number; category: string; subcategory: string | null }
  > = {};
  const categoryMap: Record<string, { total: number; count: number }> = {};
  for (const txn of debits) {
    const merchant = txn.merchant || "(missing)";
    merchantMap[merchant] ??= {
      total: 0,
      count: 0,
      category: txn.category || "Uncategorized",
      subcategory: txn.subcategory ?? null,
    };
    merchantMap[merchant].total += Number(txn.amount_inr);
    merchantMap[merchant].count++;

    const category = txn.category || "Uncategorized";
    categoryMap[category] ??= { total: 0, count: 0 };
    categoryMap[category].total += Number(txn.amount_inr);
    categoryMap[category].count++;
  }

  return {
    inrTxns,
    foreignTxns,
    summary: {
      total_debit: totalDebit,
      total_credit: totalCredit,
      net: totalDebit - totalCredit,
      txn_count: inrTxns.length,
      debit_count: debits.length,
      credit_count: credits.length,
    },
    by_merchant: Object.entries(merchantMap)
      .map(([merchant, value]) => ({ merchant, ...value }))
      .sort((a, b) => b.total - a.total),
    by_category: Object.entries(categoryMap)
      .map(([category, value]) => ({ category, ...value }))
      .sort((a, b) => b.total - a.total),
  };
}
