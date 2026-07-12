"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { CARD_REGISTRY } from "@/lib/cards/registry";
import { formatCategory } from "@/lib/categories";

type Txn = {
  id: string; card_last4: string; amount_inr: number;
  merchant: string | null; category: string | null;
  subcategory?: string | null;
  txn_at: string; txn_type: "debit" | "credit";
  notes?: string | null;
};
type CardRow = { id: string; last4: string; nickname: string | null; product_key: string };
type SortCol = "date" | "merchant" | "category" | "card" | "amount";

/** A matched order email (V2 feature C) — shown in the expand row. */
export type OrderRow = {
  id: string;
  source: string;
  kind: "order" | "refund";
  order_ref: string | null;
  merchant_name: string | null;
  total_amount: number | string | null;
  items: Array<{ name: string; qty?: number; price?: number }>;
  match_confidence: "high" | "medium" | "low" | null;
  review_status?: "unmatched" | "pending" | "confirmed" | "rejected" | null;
};

export type CategoryPatch = { category?: string; subcategory?: string | null };

interface Props {
  transactions: Txn[];
  cards: CardRow[];
  /** Canonical + custom categories — shown in the dropdown. */
  categories: string[];
  /** Per-category subcategory suggestions (canonical + user-typed). */
  subcategories: Record<string, string[]>;
  /** Matched order emails keyed by txn id. */
  ordersByTxn: Map<string, OrderRow>;
  /** All distinct existing notes — used for autofill suggestions. */
  existingNotes: string[];
  onMerchantSave: (old_name: string, new_name: string, category: string, subcategory: string | null) => Promise<void>;
  onCategoryChange: (txnId: string, patch: CategoryPatch) => Promise<void>;
  onNotesChange:    (txnId: string, notes: string) => Promise<void>;
  /** Sets the same note on every txn of a merchant (scope-choice, feature B). */
  onNotesBulk:      (merchant: string, notes: string) => Promise<void>;
}

/**
 * Note autofill matcher.
 * For input length >= 3, returns up to `max` distinct existing notes ranked:
 *   1. notes that START with the query (e.g. "pic" → "pickleball")
 *   2. notes where any WORD starts with the query (e.g. "pic" → "Pic of the day")
 *   3. notes that CONTAIN the query as a substring (e.g. "pic" → "epic")
 */
function suggestNotes(query: string, existing: string[], max = 5): string[] {
  if (query.trim().length < 3) return [];
  const q = query.trim().toLowerCase();
  const seen = new Set<string>();
  const startsWith: string[] = [];
  const wordStart: string[] = [];
  const contains: string[] = [];
  for (const note of existing) {
    if (!note) continue;
    const lower = note.toLowerCase();
    if (lower === q || seen.has(lower)) continue;
    seen.add(lower);
    if (lower.startsWith(q))                                  startsWith.push(note);
    else if (lower.split(/\s+/).some((w) => w.startsWith(q))) wordStart.push(note);
    else if (lower.includes(q))                               contains.push(note);
  }
  return [...startsWith, ...wordStart, ...contains].slice(0, max);
}

const PAGE = 25;
const fmt = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
const fmtExact = (n: number) => "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const cardLabel = (c: CardRow) =>
  c.nickname || CARD_REGISTRY[c.product_key]?.display_name || c.product_key;

const SOURCE_LABELS: Record<string, string> = {
  swiggy: "Swiggy", zomato: "Zomato", bigbasket: "BigBasket", amazon: "Amazon", blinkit: "Blinkit",
  shopify: "Shopify", generic: "Online",
};

// Sentinels for the subcategory dropdown (real values are free text).
const SUB_NONE  = "__none";
const SUB_OTHER = "__other";

/** Confidence marker for a matched order — honesty rendered as UI. A match KP
 *  has confirmed (or that auto-confirmed at high confidence) reads as settled
 *  truth regardless of how it was originally scored; pre-014 links fall back to
 *  the raw confidence nuance. */
function ConfidenceChip({ level, status }: { level: OrderRow["match_confidence"]; status?: OrderRow["review_status"] }) {
  if (status === "confirmed") {
    return <span className="text-2xs px-1.5 py-0.5 rounded-md border whitespace-nowrap text-emerald border-emerald/30 bg-emerald/5">✓ confirmed</span>;
  }
  if (!level) return null;
  const map = {
    high:   { label: "✓ matched",        cls: "text-emerald border-emerald/30 bg-emerald/5" },
    medium: { label: "≈ likely match",   cls: "text-gold border-gold/30 bg-gold/5" },
    low:    { label: "? possible match", cls: "text-mist/60 border-rim bg-raised" },
  } as const;
  const { label, cls } = map[level];
  return (
    <span className={`text-2xs px-1.5 py-0.5 rounded-md border whitespace-nowrap ${cls}`}>{label}</span>
  );
}

export default function TransactionsTable({
  transactions, cards, categories, subcategories, ordersByTxn, existingNotes,
  onMerchantSave, onCategoryChange, onNotesChange, onNotesBulk,
}: Props) {
  // ── Filters ──
  const [search, setSearch]   = useState("");
  const [amtMin, setAmtMin]   = useState("");
  const [amtMax, setAmtMax]   = useState("");
  const [sort, setSort]       = useState<{ col: SortCol; dir: "asc" | "desc" }>({ col: "date", dir: "desc" });
  const [page, setPage]       = useState(1);

  // ── Category chip filters (feature D) — multi-select; picking exactly one
  // category surfaces its subcategory chips as a second tier. ──
  const [selectedCats, setSelectedCats] = useState<Set<string>>(new Set());
  const [selectedSubs, setSelectedSubs] = useState<Set<string>>(new Set());

  // ── Order-details expansion (rows with a matched order email) ──
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // ── Category-only quick edit (two-tier) ──
  const [editCatId, setEditCatId]         = useState<string | null>(null);
  const [editCatValue, setEditCatValue]   = useState("");
  const [editCatCustom, setEditCatCustom] = useState("");
  const [editSubValue, setEditSubValue]   = useState<string>(SUB_NONE);
  const [editSubCustom, setEditSubCustom] = useState("");
  // Scope-choice (feature B): unchecked = just this transaction.
  const [applyAllCat, setApplyAllCat]     = useState(false);
  const [applyAllNote, setApplyAllNote]   = useState(false);

  // ── Full merchant edit (name + category + subcategory, applies to all matching txns) ──
  const [editMerchantId, setEditMerchantId]         = useState<string | null>(null);
  const [editMerchantName, setEditMerchantName]     = useState("");
  const [editMerchantCat, setEditMerchantCat]       = useState("");
  const [editMerchantCustom, setEditMerchantCustom] = useState("");
  const [editMerchantSub, setEditMerchantSub]       = useState<string>(SUB_NONE);
  const [editMerchantSubCustom, setEditMerchantSubCustom] = useState("");
  const [savingMerchant, setSavingMerchant]         = useState(false);

  // ── Per-transaction notes edit ──
  const [editNoteId, setEditNoteId]   = useState<string | null>(null);
  const [editNoteText, setEditNoteText] = useState("");
  const [savingNote, setSavingNote]   = useState(false);

  // NOTE: page is clamped (not reset to 1) after `processed` is computed
  // below — an in-place edit re-creates the transactions array, and resetting
  // to page 1 there would yank you off page 3 every time you saved a row.

  const cardNicknameMap = useMemo(
    () => new Map(cards.map((c) => [c.last4, cardLabel(c)])),
    [cards]
  );

  // ── Chip data (feature D): categories present in the current txn set,
  // busiest first; sub-chips appear only when exactly one category is picked.
  const categoryChips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of transactions) {
      const c = t.category || "Uncategorized";
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [transactions]);

  const subChips = useMemo(() => {
    if (selectedCats.size !== 1) return [];
    const cat = Array.from(selectedCats)[0];
    const counts = new Map<string, number>();
    for (const t of transactions) {
      if ((t.category || "Uncategorized") !== cat || !t.subcategory) continue;
      counts.set(t.subcategory, (counts.get(t.subcategory) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [transactions, selectedCats]);

  function toggleCatChip(c: string) {
    setSelectedCats((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
    setSelectedSubs(new Set()); // sub-selection belongs to a single category
    setPage(1);
  }

  function toggleSubChip(s: string) {
    setSelectedSubs((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
    setPage(1);
  }

  // ── Sort column toggle ──
  function toggleSort(col: SortCol) {
    setSort((prev) =>
      prev.col === col
        ? { col, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { col, dir: col === "date" || col === "amount" ? "desc" : "asc" }
    );
    setPage(1);
  }

  function SortIcon({ col }: { col: SortCol }) {
    if (sort.col !== col) return <span className="opacity-20 ml-0.5 text-[10px]">↕</span>;
    return <span className="text-gold ml-0.5 text-[10px]">{sort.dir === "asc" ? "↑" : "↓"}</span>;
  }

  // ── Filter + sort pipeline ──
  const processed = useMemo(() => {
    const q   = search.trim().toLowerCase();
    const min = amtMin ? parseFloat(amtMin) : null;
    const max = amtMax ? parseFloat(amtMax) : null;

    const filtered = transactions.filter((t) => {
      if (q) {
        const order      = ordersByTxn.get(t.id);
        const inMerchant = t.merchant?.toLowerCase().includes(q) ?? false;
        const inNotes    = t.notes?.toLowerCase().includes(q)    ?? false;
        // Order enrichment is searchable too: restaurant/store name + items.
        const inOrder    = order
          ? (order.merchant_name?.toLowerCase().includes(q) ?? false) ||
            order.items.some((it) => it.name.toLowerCase().includes(q))
          : false;
        if (!inMerchant && !inNotes && !inOrder) return false;
      }
      if (min !== null && t.amount_inr < min) return false;
      if (max !== null && t.amount_inr > max) return false;
      if (selectedCats.size > 0 && !selectedCats.has(t.category || "Uncategorized")) return false;
      if (selectedSubs.size > 0 && (!t.subcategory || !selectedSubs.has(t.subcategory))) return false;
      return true;
    });

    filtered.sort((a, b) => {
      let cmp = 0;
      switch (sort.col) {
        case "date":     cmp = new Date(a.txn_at).getTime() - new Date(b.txn_at).getTime(); break;
        case "merchant": cmp = (a.merchant || "").localeCompare(b.merchant || ""); break;
        case "category": cmp = formatCategory(a.category, a.subcategory).localeCompare(formatCategory(b.category, b.subcategory)); break;
        case "card":     cmp = (cardNicknameMap.get(a.card_last4) || "").localeCompare(cardNicknameMap.get(b.card_last4) || ""); break;
        case "amount":   cmp = a.amount_inr - b.amount_inr; break;
      }
      return sort.dir === "asc" ? cmp : -cmp;
    });

    return filtered;
  }, [transactions, search, amtMin, amtMax, sort, cardNicknameMap, ordersByTxn, selectedCats, selectedSubs]);

  const totalPages = Math.max(1, Math.ceil(processed.length / PAGE));
  const visible    = processed.slice((page - 1) * PAGE, page * PAGE);

  // Keep the current page in range when the data or filters change. Clamp
  // rather than reset-to-1 so editing a category/note on page 3 leaves you on
  // page 3 (filters already reset to page 1 explicitly in their handlers).
  useEffect(() => {
    setPage((p) => Math.min(Math.max(1, p), totalPages));
  }, [totalPages]);

  // ── Merchant edit helpers ──
  function startMerchantEdit(t: Txn) {
    setEditMerchantId(t.id);
    setEditMerchantName(t.merchant || "");
    const known = categories.includes(t.category || "");
    setEditMerchantCat(known ? (t.category || "Uncategorized") : "Other");
    setEditMerchantCustom(known ? "" : (t.category || ""));
    const subs = subcategories[t.category || ""] ?? [];
    const sub  = t.subcategory ?? null;
    setEditMerchantSub(sub === null ? SUB_NONE : subs.includes(sub) ? sub : SUB_OTHER);
    setEditMerchantSubCustom(sub !== null && !subs.includes(sub) ? sub : "");
    setEditCatId(null);
    setEditNoteId(null);
  }

  function startNoteEdit(t: Txn) {
    setEditNoteId(t.id);
    setEditNoteText(t.notes || "");
    setApplyAllNote(false);
    setEditMerchantId(null);
    setEditCatId(null);
  }

  function cancelNoteEdit() { setEditNoteId(null); setEditNoteText(""); setApplyAllNote(false); }

  async function commitNoteEdit(t: Txn) {
    setSavingNote(true);
    try {
      if (applyAllNote && t.merchant) await onNotesBulk(t.merchant, editNoteText);
      else await onNotesChange(t.id, editNoteText);
      cancelNoteEdit();
    }
    finally { setSavingNote(false); }
  }

  function cancelMerchantEdit() {
    setEditMerchantId(null);
    setEditMerchantName(""); setEditMerchantCat(""); setEditMerchantCustom("");
    setEditMerchantSub(SUB_NONE); setEditMerchantSubCustom("");
  }

  async function commitMerchantEdit(oldName: string) {
    const finalCat  = editMerchantCat === "Other" ? (editMerchantCustom.trim() || "Uncategorized") : editMerchantCat;
    const finalName = editMerchantName.trim() || oldName;
    const finalSub  =
      editMerchantSub === SUB_NONE  ? null :
      editMerchantSub === SUB_OTHER ? (editMerchantSubCustom.trim() || null) :
      editMerchantSub;
    setSavingMerchant(true);
    try { await onMerchantSave(oldName, finalName, finalCat, finalSub); cancelMerchantEdit(); }
    finally { setSavingMerchant(false); }
  }

  // ── Category quick-edit helpers ──
  function startCatEdit(t: Txn) {
    setEditCatId(t.id);
    const known = categories.includes(t.category || "");
    setEditCatValue(known ? (t.category || "Uncategorized") : "Other");
    setEditCatCustom(known ? "" : (t.category || ""));
    const subs = subcategories[t.category || ""] ?? [];
    const sub  = t.subcategory ?? null;
    setEditSubValue(sub === null ? SUB_NONE : subs.includes(sub) ? sub : SUB_OTHER);
    setEditSubCustom(sub !== null && !subs.includes(sub) ? sub : "");
    setApplyAllCat(false);
    setEditMerchantId(null);
    setEditNoteId(null);
  }

  function commitCatPatch(t: Txn, patch: CategoryPatch) {
    if (patch.category !== undefined && !patch.category.trim()) return;
    if (applyAllCat && t.merchant) {
      // Scope = all N from this merchant: route through the merchant-mapping
      // path (bulk txn update + mapping upsert so future syncs agree).
      const category = (patch.category ?? t.category ?? "Uncategorized").trim() || "Uncategorized";
      const subcategory = patch.subcategory !== undefined ? patch.subcategory : (t.subcategory ?? null);
      onMerchantSave(t.merchant, t.merchant, category, subcategory);
    } else {
      onCategoryChange(t.id, patch);
    }
    setEditCatId(null);
  }

  // ── Render ──
  return (
    <div className="rounded-2xl border border-rim bg-surface shadow-card overflow-hidden">

      {/* Filter bar */}
      <div className="px-5 py-3 border-b border-wire flex items-center gap-2 flex-wrap">
        <h3 className="text-2xs uppercase tracking-widest text-mist/55 shrink-0">Transactions</h3>
        <input type="text" placeholder="Search merchant, item or note…" value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="flex-1 min-w-[150px] max-w-xs bg-ink border border-rim rounded-lg px-3 py-1.5 text-xs text-mist placeholder:text-mist/25 focus:border-gold/40 outline-none" />
        <input type="number" placeholder="Min ₹" value={amtMin}
          onChange={(e) => { setAmtMin(e.target.value); setPage(1); }}
          className="w-20 bg-ink border border-rim rounded-lg px-2 py-1.5 text-xs text-mist placeholder:text-mist/25 focus:border-gold/40 outline-none" />
        <input type="number" placeholder="Max ₹" value={amtMax}
          onChange={(e) => { setAmtMax(e.target.value); setPage(1); }}
          className="w-20 bg-ink border border-rim rounded-lg px-2 py-1.5 text-xs text-mist placeholder:text-mist/25 focus:border-gold/40 outline-none" />
        <span className="text-2xs text-mist/55 ml-auto shrink-0">
          {processed.length === transactions.length
            ? `${processed.length} transactions`
            : `${processed.length} of ${transactions.length}`}
        </span>
      </div>

      {/* ── Category chips (feature D) — click to filter; pick exactly one
           category to reveal its subcategory chips. ── */}
      {categoryChips.length > 1 && (
        <div className="px-5 py-2 border-b border-wire space-y-1.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            {categoryChips.map(([c, n]) => {
              const active = selectedCats.has(c);
              return (
                <button key={c} onClick={() => toggleCatChip(c)}
                  className={`px-2 py-0.5 rounded-lg text-2xs font-medium border transition-all ${
                    active
                      ? "bg-gold text-ink border-gold"
                      : "bg-ink border-rim text-mist/60 hover:border-gold/30 hover:text-mist"
                  }`}>
                  {c} <span className={active ? "opacity-60" : "opacity-40"}>{n}</span>
                </button>
              );
            })}
            {selectedCats.size > 0 && (
              <button onClick={() => { setSelectedCats(new Set()); setSelectedSubs(new Set()); setPage(1); }}
                className="text-2xs text-mist/50 hover:text-mist ml-1 transition-colors">
                × clear
              </button>
            )}
          </div>
          {subChips.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap pl-3">
              <span className="text-2xs text-mist/35">↳</span>
              {subChips.map(([s, n]) => {
                const active = selectedSubs.has(s);
                return (
                  <button key={s} onClick={() => toggleSubChip(s)}
                    className={`px-2 py-0.5 rounded-lg text-2xs border transition-all ${
                      active
                        ? "bg-gold/80 text-ink border-gold"
                        : "bg-ink border-rim text-mist/50 hover:border-gold/30 hover:text-mist"
                    }`}>
                    {s} <span className={active ? "opacity-60" : "opacity-40"}>{n}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      <table className="w-full text-sm">
        <thead className="border-b border-wire">
          <tr>
            {(["date", "merchant", "category", "card"] as const).map((col) => (
              <th key={col} onClick={() => toggleSort(col)}
                className="text-left px-5 py-2.5 text-2xs font-medium uppercase tracking-widest text-mist/55 cursor-pointer hover:text-mist/50 select-none capitalize">
                {col} <SortIcon col={col} />
              </th>
            ))}
            <th onClick={() => toggleSort("amount")}
              className="text-right px-5 py-2.5 text-2xs font-medium uppercase tracking-widest text-mist/55 cursor-pointer hover:text-mist/50 select-none">
              Amount <SortIcon col="amount" />
            </th>
          </tr>
        </thead>
        <tbody>
          {visible.map((t) => {
            const isMerchantEditing = editMerchantId === t.id;
            const isCatEditing      = editCatId === t.id;
            const isNoteEditing     = editNoteId === t.id;
            const noteSuggestions   = isNoteEditing ? suggestNotes(editNoteText, existingNotes) : [];
            const order             = ordersByTxn.get(t.id);
            const isExpanded        = expandedId === t.id;
            // "Auto-rename": for confident matches the order's real merchant
            // (restaurant/store) leads and the bank's name becomes the
            // subtext. Low-confidence guesses stay in the expand panel only.
            const enrichedName = order?.merchant_name && order.match_confidence !== "low"
              ? order.merchant_name
              : null;
            const subOptions = subcategories[editCatValue] ?? [];
            const merchantSubOptions = subcategories[editMerchantCat] ?? [];
            // Scope-choice count — only computed while this row is being edited.
            const sameMerchantCount = (isCatEditing || isNoteEditing) && t.merchant
              ? transactions.reduce((n, x) => n + (x.merchant === t.merchant ? 1 : 0), 0)
              : 0;

            return (
              <Fragment key={t.id}>
              <tr className="group border-b border-wire last:border-0 hover:bg-raised transition-colors">

                {/* Date */}
                <td className="px-5 py-3 text-mist/60 text-xs whitespace-nowrap align-top">
                  {new Date(t.txn_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit" })}
                </td>

                {/* Merchant — click to rename (applies to ALL transactions with same name) */}
                <td className="px-5 py-3 align-top min-w-[140px]">
                  {isMerchantEditing ? (
                    <div className="space-y-1.5 py-0.5">
                      <input autoFocus value={editMerchantName}
                        onChange={(e) => setEditMerchantName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") commitMerchantEdit(t.merchant || ""); if (e.key === "Escape") cancelMerchantEdit(); }}
                        className="w-full bg-ink border border-gold/40 rounded-lg px-2 py-1 text-xs text-mist focus:border-gold outline-none" />
                      <select value={editMerchantCat}
                        onChange={(e) => { setEditMerchantCat(e.target.value); setEditMerchantSub(SUB_NONE); setEditMerchantSubCustom(""); }}
                        className="w-full bg-ink border border-rim rounded-lg px-2 py-1 text-xs text-mist focus:border-gold/40 outline-none">
                        {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                        <option value="Other">Other (type below)</option>
                      </select>
                      {editMerchantCat === "Other" && (
                        <input placeholder="Custom category…" value={editMerchantCustom}
                          onChange={(e) => setEditMerchantCustom(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") commitMerchantEdit(t.merchant || ""); if (e.key === "Escape") cancelMerchantEdit(); }}
                          className="w-full bg-ink border border-rim rounded-lg px-2 py-1 text-xs text-mist focus:border-gold/40 outline-none" />
                      )}
                      <select value={editMerchantSub}
                        onChange={(e) => setEditMerchantSub(e.target.value)}
                        className="w-full bg-ink border border-rim rounded-lg px-2 py-1 text-xs text-mist focus:border-gold/40 outline-none">
                        <option value={SUB_NONE}>No subcategory</option>
                        {merchantSubOptions.map((s) => <option key={s} value={s}>{s}</option>)}
                        <option value={SUB_OTHER}>Other (type below)</option>
                      </select>
                      {editMerchantSub === SUB_OTHER && (
                        <input placeholder="Custom subcategory…" value={editMerchantSubCustom}
                          onChange={(e) => setEditMerchantSubCustom(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") commitMerchantEdit(t.merchant || ""); if (e.key === "Escape") cancelMerchantEdit(); }}
                          className="w-full bg-ink border border-rim rounded-lg px-2 py-1 text-xs text-mist focus:border-gold/40 outline-none" />
                      )}
                      <div className="flex items-center gap-1.5 pt-0.5">
                        <button onClick={() => commitMerchantEdit(t.merchant || "")} disabled={savingMerchant}
                          className="px-2.5 py-1 text-xs bg-gold-shimmer text-ink rounded-lg font-semibold disabled:opacity-50">
                          {savingMerchant ? "…" : "Save"}
                        </button>
                        <button onClick={cancelMerchantEdit}
                          className="px-2.5 py-1 text-xs border border-rim rounded-lg hover:border-gold/30 text-mist/60 hover:text-mist">
                          Cancel
                        </button>
                        <span className="text-2xs text-mist/25 ml-1">renames all &quot;{t.merchant}&quot;</span>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start gap-1">
                      {order && (
                        <button onClick={() => setExpandedId(isExpanded ? null : t.id)}
                          title={isExpanded ? "Hide order details" : "Show order details"}
                          className={`shrink-0 mt-0.5 text-2xs transition-transform ${isExpanded ? "rotate-90 text-gold" : "text-gold/60 hover:text-gold"}`}>
                          ▶
                        </button>
                      )}
                      <button onClick={() => startMerchantEdit(t)} title="Click to rename merchant"
                        className="group/m flex flex-col text-left w-full text-mist/80 hover:text-gold transition-colors">
                        <span className="flex items-center gap-1">
                          <span>{enrichedName ?? t.merchant ?? <span className="text-mist/25 italic text-xs">missing</span>}</span>
                          <span className="opacity-0 group-hover/m:opacity-40 text-2xs shrink-0 ml-0.5">✏</span>
                        </span>
                        {enrichedName && (
                          <span className="text-2xs text-mist/35">via {t.merchant}</span>
                        )}
                      </button>
                    </div>
                  )}

                  {/* ── Notes (per-transaction) ── */}
                  {!isMerchantEditing && (
                    isNoteEditing ? (
                      <div className="mt-1.5 space-y-1 relative">
                        <textarea autoFocus rows={2} value={editNoteText} placeholder="Add a note (e.g. 'pickleball at Huddle')…"
                          onChange={(e) => setEditNoteText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commitNoteEdit(t);
                            if (e.key === "Escape") cancelNoteEdit();
                          }}
                          className="w-full bg-ink border border-gold/40 rounded-lg px-2 py-1 text-xs text-mist focus:border-gold outline-none resize-none" />
                        {noteSuggestions.length > 0 && (
                          <div className="absolute z-10 left-0 right-0 top-full mt-0.5 bg-raised border border-rim rounded-xl shadow-dropdown max-h-40 overflow-y-auto">
                            <div className="px-2 py-1 text-2xs uppercase tracking-widest text-mist/55 border-b border-wire">Existing notes</div>
                            {noteSuggestions.map((s, i) => (
                              <button key={i} onMouseDown={(e) => { e.preventDefault(); setEditNoteText(s); }}
                                className="w-full text-left px-2 py-1.5 text-xs text-mist/70 hover:bg-hover hover:text-mist truncate transition-colors">
                                {s}
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <button onClick={() => commitNoteEdit(t)} disabled={savingNote}
                            className="px-2 py-0.5 text-[11px] bg-gold-shimmer text-ink rounded-lg font-semibold disabled:opacity-50">
                            {savingNote ? "…" : "Save"}
                          </button>
                          <button onClick={cancelNoteEdit}
                            className="px-2 py-0.5 text-[11px] border border-rim rounded-lg hover:border-gold/30 text-mist/60">
                            Cancel
                          </button>
                          {sameMerchantCount > 1 && (
                            <label className="flex items-center gap-1 text-2xs text-mist/60 cursor-pointer select-none">
                              <input type="checkbox" checked={applyAllNote}
                                onChange={(e) => setApplyAllNote(e.target.checked)} className="accent-gold" />
                              all {sameMerchantCount} from this merchant
                            </label>
                          )}
                          <span className="text-2xs text-mist/25 ml-0.5">⌘↵</span>
                        </div>
                      </div>
                    ) : t.notes ? (
                      <button onClick={() => startNoteEdit(t)} title="Click to edit note"
                        className="group/n mt-1 flex items-start gap-1 text-left text-xs italic text-mist/60 hover:text-mist/70 transition-colors w-full">
                        <span className="text-gold/40 shrink-0 not-italic text-2xs mt-0.5">📝</span>
                        <span className="break-words">{t.notes}</span>
                      </button>
                    ) : (
                      <button onClick={() => startNoteEdit(t)}
                        className="opacity-0 group-hover:opacity-40 hover:!opacity-80 mt-1 text-2xs text-mist/50 italic transition-opacity">
                        + add note
                      </button>
                    )
                  )}
                </td>

                {/* Category — click to change (explicit Save keeps category + subcategory in sync) */}
                <td className="px-5 py-3 text-xs align-top">
                  {isCatEditing ? (
                    <div className="space-y-1">
                      {sameMerchantCount > 1 && (
                        <label className="flex items-center gap-1.5 text-2xs text-mist/60 cursor-pointer select-none">
                          <input type="checkbox" checked={applyAllCat}
                            onChange={(e) => setApplyAllCat(e.target.checked)} className="accent-gold" />
                          All {sameMerchantCount} from &quot;{t.merchant}&quot;
                        </label>
                      )}
                      <select autoFocus value={editCatValue}
                        onChange={(e) => {
                          setEditCatValue(e.target.value);
                          setEditSubValue(SUB_NONE);
                          setEditSubCustom("");
                        }}
                        onKeyDown={(e) => { if (e.key === "Escape") setEditCatId(null); }}
                        className="bg-ink border border-gold/40 rounded-lg px-2 py-1 text-xs text-mist outline-none">
                        {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                        <option value="Other">Other (type below)</option>
                      </select>
                      {editCatValue === "Other" && (
                        <input placeholder="Custom category…" value={editCatCustom}
                          onChange={(e) => setEditCatCustom(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Escape") setEditCatId(null); }}
                          className="w-full bg-ink border border-rim rounded-lg px-2 py-1 text-xs text-mist focus:border-gold/40 outline-none" />
                      )}
                      {/* Subcategory — always shown so KP can set it for any category */}
                      <select value={editSubValue}
                        onChange={(e) => { setEditSubValue(e.target.value); setEditSubCustom(""); }}
                        onKeyDown={(e) => { if (e.key === "Escape") setEditCatId(null); }}
                        className="bg-ink border border-rim rounded-lg px-2 py-1 text-xs text-mist outline-none block">
                        <option value={SUB_NONE}>No subcategory</option>
                        {subOptions.map((s) => <option key={s} value={s}>{s}</option>)}
                        <option value={SUB_OTHER}>Other (type below)</option>
                      </select>
                      {editSubValue === SUB_OTHER && (
                        <input placeholder="Custom subcategory…" value={editSubCustom}
                          onChange={(e) => setEditSubCustom(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Escape") setEditCatId(null); }}
                          className="w-full bg-ink border border-rim rounded-lg px-2 py-1 text-xs text-mist focus:border-gold/40 outline-none" />
                      )}
                      <div className="flex items-center gap-1.5 pt-0.5">
                        <button onClick={() => {
                          const cat = editCatValue === "Other" ? (editCatCustom.trim() || "Uncategorized") : editCatValue;
                          const sub = editSubValue === SUB_NONE ? null
                            : editSubValue === SUB_OTHER ? (editSubCustom.trim() || null)
                            : editSubValue;
                          if (cat) commitCatPatch(t, { category: cat, subcategory: sub });
                        }}
                          className="px-2.5 py-1 text-xs bg-gold-shimmer text-ink rounded-lg font-semibold">
                          Save
                        </button>
                        <button onClick={() => setEditCatId(null)}
                          className="px-2.5 py-1 text-xs border border-rim rounded-lg hover:border-gold/30 text-mist/60 hover:text-mist">
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => startCatEdit(t)} title="Click to change category"
                      className="text-mist/50 hover:text-gold transition-colors text-left">
                      {t.subcategory
                        ? <>{t.category || "Uncategorized"} <span className="text-mist/35">· {t.subcategory}</span></>
                        : (t.category || "Uncategorized")}
                    </button>
                  )}
                </td>

                {/* Card — show nickname */}
                <td className="px-5 py-3 text-mist/35 text-xs align-top whitespace-nowrap">
                  {cardNicknameMap.get(t.card_last4) ?? `··${t.card_last4}`}
                </td>

                {/* Amount */}
                <td className={`px-5 py-3 text-right font-semibold whitespace-nowrap align-top tabular-nums ${
                  t.txn_type === "credit" ? "text-emerald" : "text-mist/90"
                }`}>
                  {t.txn_type === "credit" ? "+" : ""}{fmt(t.amount_inr)}
                </td>
              </tr>

              {/* ── Expanded order details ── */}
              {isExpanded && order && (
                <tr className="border-b border-wire bg-ink/40">
                  <td colSpan={5} className="px-5 py-3">
                    <div className="ml-6 space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-2xs uppercase tracking-widest text-gold/70">
                          {SOURCE_LABELS[order.source] ?? order.source}
                          {order.kind === "refund" ? " refund" : " order"}
                        </span>
                        {order.merchant_name && (
                          <span className="text-xs text-mist/80">{order.merchant_name}</span>
                        )}
                        <ConfidenceChip level={order.match_confidence} status={order.review_status} />
                        {order.order_ref && (
                          <span className="text-2xs text-mist/40 ml-auto tabular-nums">#{order.order_ref}</span>
                        )}
                      </div>
                      {order.items.length > 0 ? (
                        <ul className="space-y-0.5">
                          {order.items.map((it, i) => (
                            <li key={i} className="flex items-baseline gap-2 text-xs">
                              <span className="text-mist/70">
                                {it.qty != null && it.qty !== 1 ? `${it.qty} × ` : ""}{it.name}
                              </span>
                              {it.price != null && (
                                <span className="text-mist/40 tabular-nums ml-auto">{fmtExact(it.price)}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="text-2xs text-mist/40 italic">No line items in this email</div>
                      )}
                      {order.total_amount != null && (
                        <div className="text-2xs text-mist/50 pt-1 border-t border-wire/50">
                          Order total {fmtExact(Number(order.total_amount))}
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              )}
              </Fragment>
            );
          })}
        </tbody>
      </table>

      {totalPages > 1 && (
        <div className="px-5 py-3 border-t border-wire flex items-center justify-between">
          <span className="text-2xs text-mist/55 tabular-nums">
            {(page - 1) * PAGE + 1}–{Math.min(page * PAGE, processed.length)} of {processed.length}
          </span>
          <div className="flex items-center gap-1.5 text-xs">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
              className="px-2 py-1 border border-rim rounded-lg disabled:opacity-20 hover:border-gold/30 text-mist/60 hover:text-mist transition-all">‹</button>
            <span className="text-mist/60 tabular-nums">{page}/{totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}
              className="px-2 py-1 border border-rim rounded-lg disabled:opacity-20 hover:border-gold/30 text-mist/60 hover:text-mist transition-all">›</button>
          </div>
        </div>
      )}
    </div>
  );
}
