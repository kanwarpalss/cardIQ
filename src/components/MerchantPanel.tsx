"use client";

import { useState } from "react";
import { pairLabel, type CategoryPair, type CreateSuggestion, type Taxonomy } from "@/lib/category-taxonomy";
import CategoryField from "./category/CategoryField";

type MerchantRow = { merchant: string; total: number; count: number; category: string; subcategory: string | null };

interface Props {
  merchants: MerchantRow[];
  maxTotal: number;
  /** The user's category tree — the picker shows all of it at once. */
  taxonomy: Taxonomy;
  onCreateCategory: (s: CreateSuggestion) => Promise<CategoryPair | null>;
  /** Called when a rename/recategorize is saved. */
  onSave: (old_name: string, new_name: string, category: string, subcategory: string | null) => Promise<void>;
}

const fmt = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

export default function MerchantPanel({ merchants, maxTotal, taxonomy, onCreateCategory, onSave }: Props) {
  const [editingMerchant, setEditingMerchant] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editPair, setEditPair] = useState<CategoryPair>({ category: "Uncategorized", subcategory: null });
  const [saving, setSaving] = useState(false);

  function startEdit(m: MerchantRow) {
    setEditingMerchant(m.merchant);
    setEditName(m.merchant);
    setEditPair({ category: m.category || "Uncategorized", subcategory: m.subcategory });
  }

  function cancelEdit() {
    setEditingMerchant(null);
    setEditName("");
  }

  async function commitEdit(oldMerchant: string) {
    const finalName = editName.trim() || oldMerchant;
    setSaving(true);
    try {
      await onSave(oldMerchant, finalName, editPair.category, editPair.subcategory);
      setEditingMerchant(null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      {merchants.map((m) => {
        const isEditing = editingMerchant === m.merchant;

        if (isEditing) {
          return (
            <div key={m.merchant} className="p-2 -mx-2 rounded border border-gold/30 bg-gold/5 space-y-2">
              {/* Name input */}
              <div className="space-y-1">
                <label className="text-xs opacity-40 uppercase tracking-wider">Merchant name</label>
                <input
                  autoFocus
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") commitEdit(m.merchant); if (e.key === "Escape") cancelEdit(); }}
                  className="w-full bg-panel border border-line rounded px-2 py-1 text-sm focus:border-gold outline-none"
                />
              </div>

              {/* Category + subcategory — one picker showing the whole tree */}
              <div className="space-y-1">
                <span className="text-xs opacity-40 uppercase tracking-wider">Category</span>
                <CategoryField
                  label={`Category for every ${m.merchant} transaction`}
                  context={`Applies to all ${m.count} and future ones`}
                  value={editPair}
                  onChange={setEditPair}
                  taxonomy={taxonomy}
                  onCreate={onCreateCategory}
                />
              </div>

              {/* Action buttons */}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => commitEdit(m.merchant)}
                  disabled={saving}
                  className="px-3 py-1 text-xs bg-gold text-ink rounded font-medium disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  onClick={cancelEdit}
                  disabled={saving}
                  className="px-3 py-1 text-xs border border-line rounded hover:border-gold/60 disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>

              {/* Total shown in collapsed form during edit */}
              <div className="text-xs opacity-40 pt-1">
                {m.count} transactions · {fmt(m.total)}
              </div>
            </div>
          );
        }

        return (
          <div key={m.merchant} className="group">
            <div className="flex justify-between items-baseline text-sm gap-2">
              <div className="flex items-center gap-1.5 min-w-0 flex-1">
                <span className="truncate">{m.merchant}</span>
                <button
                  onClick={() => startEdit(m)}
                  title="Edit merchant name, category or subcategory"
                  aria-label={`Edit ${m.merchant}`}
                  className="opacity-0 group-hover:opacity-60 focus:opacity-100 hover:!opacity-100 transition text-xs shrink-0 leading-none"
                >
                  ✏
                </button>
              </div>
              <span className="text-xs opacity-40 shrink-0">
                {pairLabel(m.category, m.subcategory)}
              </span>
              <span className="text-gold/80 shrink-0">{fmt(m.total)}</span>
            </div>
            <div className="flex items-center gap-2 mt-1">
              <div className="flex-1 h-1 bg-line rounded-full overflow-hidden">
                <div className="h-full bg-gold/40 rounded-full" style={{ width: `${(m.total / maxTotal) * 100}%` }} />
              </div>
              <span className="text-xs opacity-40 w-10 text-right shrink-0">{m.count}×</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
