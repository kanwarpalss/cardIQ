"use client";

import { useId, useState } from "react";
import { pairLabel, type CategoryPair, type CreateSuggestion, type Taxonomy } from "@/lib/category-taxonomy";
import Sheet from "./Sheet";
import CategoryPicker from "./CategoryPicker";

/**
 * A form field showing the chosen "Category · Subcategory"; clicking it opens
 * the full picker. Used where the category is one part of a bigger edit
 * (the merchant rename editors) — it only reports the choice, it saves nothing.
 */
export default function CategoryField({ value, onChange, taxonomy, onCreate, label = "Category", context }: {
  value: CategoryPair;
  onChange: (pair: CategoryPair) => void;
  taxonomy: Taxonomy;
  onCreate: (s: CreateSuggestion) => Promise<CategoryPair | null>;
  label?: string;
  context?: string;
}) {
  const labelId = useId();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="cat-field" aria-label={`${label}: ${pairLabel(value.category, value.subcategory)} — change`} onClick={() => setOpen(true)}>
        <span className="cat-field-value">{pairLabel(value.category, value.subcategory)}</span>
        <span aria-hidden="true" className="cat-field-caret">▾</span>
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} labelledBy={labelId} wide>
        <CategoryPicker
          labelId={labelId}
          taxonomy={taxonomy}
          current={value}
          heading={label}
          detail={context}
          onPick={(pair) => { onChange(pair); setOpen(false); }}
          onCreate={onCreate}
          onCancel={() => setOpen(false)}
        />
      </Sheet>
    </>
  );
}
