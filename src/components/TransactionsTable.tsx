"use client";

import { useEffect, useMemo, useState } from "react";
import { CARD_REGISTRY } from "@/lib/cards/registry";

type Txn = {
  id: string; card_last4: string; amount_inr: number;
  merchant: string | null; category: string | null;
  txn_at: string; txn_type: "debit" | "credit";
  notes?: string | null;
};
type CardRow = { id: string; last4: string; nickname: string | null; product_key: string };
type SortCol = "date" | "merchant" | "category" | "card" | "amount";

interface Props {
  transactions: Txn[];
  cards: CardRow[];
  /** Canonical + custom categories — shown in the dropdown. */
  categories: string[];
  /** All distinct existing notes — used for autofill suggestions. */
  existingNotes: string[];
  onMerchantSave: (old_name: string, new_name: string, category: string) => Promise<void>;
  onCategoryChange: (txnId: string, category: string) => Promise<void>;
  onNotesChange:    (txnId: string, notes: string) => Promise<void>;
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
const cardLabel = (c: CardRow) =>
  c.nickname || CARD_REGISTRY[c.product_key]?.display_name || c.product_key;

export default function TransactionsTable({
  transactions, cards, categories, existingNotes,
  onMerchantSave, onCategoryChange, onNotesChange,
}: Props) {
  // ── Filters ──
  const [search, setSearch]   = useState("");
  const [amtMin, setAmtMin]   = useState("");
  const [amtMax, setAmtMax]   = useState("");
  const [sort, setSort]       = useState<{ col: SortCol; dir: "asc" | "desc" }>({ col: "date", dir: "desc" });
  const [page, setPage]       = useState(1);

  // ── Category-only quick edit ──
  const [editCatId, setEditCatId]         = useState<string | null>(null);
  const [editCatValue, setEditCatValue]   = useState("");
  const [editCatCustom, setEditCatCustom] = useState("");

  // ── Full merchant edit (name + category, applies to all matching txns) ──
  const [editMerchantId, setEditMerchantId]         = useState<string | null>(null);
  const [editMerchantName, setEditMerchantName]     = useState("");
  const [editMerchantCat, setEditMerchantCat]       = useState("");
  const [editMerchantCustom, setEditMerchantCustom] = useState("");
  const [savingMerchant, setSavingMerchant]         = useState(false);

  // ── Per-transaction notes edit ──
  const [editNoteId, setEditNoteId]   = useState<string | null>(null);
  const [editNoteText, setEditNoteText] = useState("");
  const [savingNote, setSavingNote]   = useState(false);

  // Reset to page 1 whenever the upstream transaction list changes
  useEffect(() => { setPage(1); }, [transactions]);

  const cardNicknameMap = useMemo(
    () => new Map(cards.map((c) => [c.last4, cardLabel(c)])),
    [cards]
  );

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
        const inMerchant = t.merchant?.toLowerCase().includes(q) ?? false;
        const inNotes    = t.notes?.toLowerCase().includes(q)    ?? false;
        if (!inMerchant && !inNotes) return false;
      }
      if (min !== null && t.amount_inr < min) return false;
      if (max !== null && t.amount_inr > max) return false;
      return true;
    });

    filtered.sort((a, b) => {
      let cmp = 0;
      switch (sort.col) {
        case "date":     cmp = new Date(a.txn_at).getTime() - new Date(b.txn_at).getTime(); break;
        case "merchant": cmp = (a.merchant || "").localeCompare(b.merchant || ""); break;
        case "category": cmp = (a.category || "").localeCompare(b.category || ""); break;
        case "card":     cmp = (cardNicknameMap.get(a.card_last4) || "").localeCompare(cardNicknameMap.get(b.card_last4) || ""); break;
        case "amount":   cmp = a.amount_inr - b.amount_inr; break;
      }
      return sort.dir === "asc" ? cmp : -cmp;
    });

    return filtered;
  }, [transactions, search, amtMin, amtMax, sort, cardNicknameMap]);

  const totalPages = Math.ceil(processed.length / PAGE);
  const visible    = processed.slice((page - 1) * PAGE, page * PAGE);

  // ── Merchant edit helpers ──
  function startMerchantEdit(t: Txn) {
    setEditMerchantId(t.id);
    setEditMerchantName(t.merchant || "");
    const known = categories.includes(t.category || "");
    setEditMerchantCat(known ? (t.category || "Uncategorized") : "Other");
    setEditMerchantCustom(known ? "" : (t.category || ""));
    setEditCatId(null);
    setEditNoteId(null);
  }

  function startNoteEdit(t: Txn) {
    setEditNoteId(t.id);
    setEditNoteText(t.notes || "");
    setEditMerchantId(null);
    setEditCatId(null);
  }

  function cancelNoteEdit() { setEditNoteId(null); setEditNoteText(""); }

  async function commitNoteEdit(txnId: string) {
    setSavingNote(true);
    try { await onNotesChange(txnId, editNoteText); cancelNoteEdit(); }
    finally { setSavingNote(false); }
  }

  function cancelMerchantEdit() {
    setEditMerchantId(null);
    setEditMerchantName(""); setEditMerchantCat(""); setEditMerchantCustom("");
  }

  async function commitMerchantEdit(oldName: string) {
    const finalCat  = editMerchantCat === "Other" ? (editMerchantCustom.trim() || "Uncategorized") : editMerchantCat;
    const finalName = editMerchantName.trim() || oldName;
    setSavingMerchant(true);
    try { await onMerchantSave(oldName, finalName, finalCat); cancelMerchantEdit(); }
    finally { setSavingMerchant(false); }
  }

  // ── Category quick-edit helpers ──
  function startCatEdit(t: Txn) {
    setEditCatId(t.id);
    const known = categories.includes(t.category || "");
    setEditCatValue(known ? (t.category || "Uncategorized") : "Other");
    setEditCatCustom(known ? "" : (t.category || ""));
    setEditMerchantId(null);
    setEditNoteId(null);
  }

  function commitCatEdit(txnId: string, cat: string) {
    if (!cat.trim()) return;
    onCategoryChange(txnId, cat.trim());
    setEditCatId(null);
  }

  // ── Render ──
  return (
    <div className="border border-line rounded-lg overflow-hidden bg-panel/30">

      {/* Filter bar */}
      <div className="px-4 py-3 border-b border-line flex items-center gap-2 flex-wrap">
        <h3 className="text-xs uppercase tracking-widest opacity-50 shrink-0">Transactions</h3>
        <input type="text" placeholder="Search merchant…" value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="flex-1 min-w-[150px] max-w-xs bg-panel border border-line rounded px-3 py-1 text-xs focus:border-gold outline-none" />
        <input type="number" placeholder="Min ₹" value={amtMin}
          onChange={(e) => { setAmtMin(e.target.value); setPage(1); }}
          className="w-20 bg-panel border border-line rounded px-2 py-1 text-xs focus:border-gold outline-none" />
        <input type="number" placeholder="Max ₹" value={amtMax}
          onChange={(e) => { setAmtMax(e.target.value); setPage(1); }}
          className="w-20 bg-panel border border-line rounded px-2 py-1 text-xs focus:border-gold outline-none" />
        <span className="text-xs opacity-40 ml-auto shrink-0">
          {processed.length === transactions.length
            ? `${processed.length} transactions`
            : `${processed.length} of ${transactions.length} transactions`}
        </span>
      </div>

      <table className="w-full text-sm">
        <thead className="text-xs opacity-50 border-b border-line">
          <tr>
            {(["date", "merchant", "category", "card"] as const).map((col) => (
              <th key={col} onClick={() => toggleSort(col)}
                className="text-left px-4 py-2 font-normal cursor-pointer hover:opacity-80 select-none capitalize">
                {col} <SortIcon col={col} />
              </th>
            ))}
            <th onClick={() => toggleSort("amount")}
              className="text-right px-4 py-2 font-normal cursor-pointer hover:opacity-80 select-none">
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

            return (
              <tr key={t.id} className="group border-b border-line/40 last:border-0 hover:bg-white/[0.02]">

                {/* Date */}
                <td className="px-4 py-2 opacity-60 text-xs whitespace-nowrap align-top pt-3">
                  {new Date(t.txn_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit" })}
                </td>

                {/* Merchant — click to rename (applies to ALL transactions with same name) */}
                <td className="px-4 py-2 align-top min-w-[140px]">
                  {isMerchantEditing ? (
                    <div className="space-y-1.5 py-0.5">
                      <input autoFocus value={editMerchantName}
                        onChange={(e) => setEditMerchantName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") commitMerchantEdit(t.merchant || ""); if (e.key === "Escape") cancelMerchantEdit(); }}
                        className="w-full bg-panel border border-gold/50 rounded px-2 py-1 text-xs focus:border-gold outline-none" />
                      <select value={editMerchantCat} onChange={(e) => setEditMerchantCat(e.target.value)}
                        className="w-full bg-panel border border-line rounded px-2 py-1 text-xs focus:border-gold outline-none">
                        {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                        <option value="Other">Other (type below)</option>
                      </select>
                      {editMerchantCat === "Other" && (
                        <input placeholder="Custom category…" value={editMerchantCustom}
                          onChange={(e) => setEditMerchantCustom(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") commitMerchantEdit(t.merchant || ""); if (e.key === "Escape") cancelMerchantEdit(); }}
                          className="w-full bg-panel border border-line rounded px-2 py-1 text-xs focus:border-gold outline-none" />
                      )}
                      <div className="flex items-center gap-1.5 pt-0.5">
                        <button onClick={() => commitMerchantEdit(t.merchant || "")} disabled={savingMerchant}
                          className="px-2.5 py-1 text-xs bg-gold text-ink rounded font-medium disabled:opacity-50">
                          {savingMerchant ? "…" : "Save"}
                        </button>
                        <button onClick={cancelMerchantEdit}
                          className="px-2.5 py-1 text-xs border border-line rounded hover:border-gold/60">
                          Cancel
                        </button>
                        <span className="text-[10px] opacity-30 ml-1">renames all "{t.merchant}"</span>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => startMerchantEdit(t)} title="Click to rename merchant"
                      className="group/m flex items-center gap-1 text-left w-full hover:text-gold/90 transition">
                      <span>{t.merchant || <span className="opacity-30 italic">missing</span>}</span>
                      <span className="opacity-0 group-hover/m:opacity-40 text-[10px] shrink-0">✏</span>
                    </button>
                  )}

                  {/* ── Notes (per-transaction) ── */}
                  {!isMerchantEditing && (
                    isNoteEditing ? (
                      <div className="mt-1.5 space-y-1 relative">
                        <textarea autoFocus rows={2} value={editNoteText} placeholder="Add a note (e.g. 'pickleball at Huddle')…"
                          onChange={(e) => setEditNoteText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commitNoteEdit(t.id);
                            if (e.key === "Escape") cancelNoteEdit();
                          }}
                          className="w-full bg-panel border border-gold/50 rounded px-2 py-1 text-xs focus:border-gold outline-none resize-none" />
                        {noteSuggestions.length > 0 && (
                          <div className="absolute z-10 left-0 right-0 top-full mt-0.5 bg-panel border border-line rounded shadow-lg max-h-40 overflow-y-auto">
                            <div className="px-2 py-1 text-[10px] uppercase tracking-wider opacity-40 border-b border-line/40">Existing notes</div>
                            {noteSuggestions.map((s, i) => (
                              <button key={i} onMouseDown={(e) => { e.preventDefault(); setEditNoteText(s); }}
                                className="w-full text-left px-2 py-1 text-xs hover:bg-gold/10 truncate">
                                {s}
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="flex items-center gap-1.5">
                          <button onClick={() => commitNoteEdit(t.id)} disabled={savingNote}
                            className="px-2 py-0.5 text-[11px] bg-gold text-ink rounded font-medium disabled:opacity-50">
                            {savingNote ? "…" : "Save"}
                          </button>
                          <button onClick={cancelNoteEdit}
                            className="px-2 py-0.5 text-[11px] border border-line rounded hover:border-gold/60">
                            Cancel
                          </button>
                          <span className="text-[10px] opacity-30 ml-0.5">⌘↵ to save</span>
                        </div>
                      </div>
                    ) : t.notes ? (
                      <button onClick={() => startNoteEdit(t)} title="Click to edit note"
                        className="group/n mt-0.5 flex items-start gap-1 text-left text-[11px] italic opacity-60 hover:opacity-100 transition w-full">
                        <span className="text-gold/60 shrink-0 not-italic">📝</span>
                        <span className="break-words">{t.notes}</span>
                      </button>
                    ) : (
                      <button onClick={() => startNoteEdit(t)}
                        className="opacity-0 group-hover:opacity-50 hover:!opacity-100 mt-0.5 text-[10px] italic transition">
                        + add note
                      </button>
                    )
                  )}
                </td>

                {/* Category — click to change (this transaction only) */}
                <td className="px-4 py-2 text-xs opacity-70 align-top pt-3">
                  {isCatEditing ? (
                    <div className="space-y-1">
                      <select autoFocus value={editCatValue}
                        onChange={(e) => {
                          setEditCatValue(e.target.value);
                          if (e.target.value !== "Other") commitCatEdit(t.id, e.target.value);
                        }}
                        onBlur={() => { if (editCatValue !== "Other") setEditCatId(null); }}
                        className="bg-panel border border-gold/50 rounded px-1 py-0.5 text-xs outline-none">
                        {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                        <option value="Other">Other (type below)</option>
                      </select>
                      {editCatValue === "Other" && (
                        <div className="flex gap-1 mt-0.5">
                          <input autoFocus placeholder="Custom…" value={editCatCustom}
                            onChange={(e) => setEditCatCustom(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitCatEdit(t.id, editCatCustom);
                              if (e.key === "Escape") setEditCatId(null);
                            }}
                            className="w-28 bg-panel border border-gold/50 rounded px-1 py-0.5 text-xs outline-none" />
                          <button onClick={() => commitCatEdit(t.id, editCatCustom)}
                            className="px-1.5 py-0.5 text-xs bg-gold text-ink rounded">✓</button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <button onClick={() => startCatEdit(t)} title="Click to change category (this transaction)"
                      className="hover:text-gold transition text-left">
                      {t.category || "Uncategorized"}
                    </button>
                  )}
                </td>

                {/* Card — show nickname */}
                <td className="px-4 py-2 opacity-50 text-xs align-top pt-3 whitespace-nowrap">
                  {cardNicknameMap.get(t.card_last4) ?? `··${t.card_last4}`}
                </td>

                {/* Amount */}
                <td className={`px-4 py-2 text-right font-medium whitespace-nowrap align-top pt-3 ${t.txn_type === "credit" ? "text-green-400" : ""}`}>
                  {t.txn_type === "credit" ? "+" : ""}{fmt(t.amount_inr)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {totalPages > 1 && (
        <div className="px-4 py-3 border-t border-line flex items-center justify-between">
          <span className="text-xs opacity-40">
            {(page - 1) * PAGE + 1}–{Math.min(page * PAGE, processed.length)} of {processed.length}
          </span>
          <div className="flex items-center gap-2 text-xs">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
              className="px-2 py-1 border border-line rounded disabled:opacity-30 hover:border-gold/60">‹</button>
            <span className="opacity-60">Page {page} of {totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}
              className="px-2 py-1 border border-line rounded disabled:opacity-30 hover:border-gold/60">›</button>
          </div>
        </div>
      )}
    </div>
  );
}
