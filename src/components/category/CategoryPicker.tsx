"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  createSuggestions,
  pairLabel,
  searchTaxonomy,
  type CategoryPair,
  type CreateSuggestion,
  type Taxonomy,
} from "@/lib/category-taxonomy";

/**
 * Every category with its subcategories, on one screen. One click on a
 * category picks it alone; one click on a subcategory chip picks both.
 * Type to narrow ("coff" → Dining › Coffee, "dining/res" → Dining ›
 * Restaurants); ↑/↓ + Enter work from the search box; "+ Create" rows add
 * a new category or subcategory without leaving the picker.
 */
type Option =
  | { kind: "pick"; pair: CategoryPair }
  | { kind: "create"; suggestion: CreateSuggestion };

export default function CategoryPicker({
  labelId, taxonomy, current, heading, detail, onPick, onCreate, onManage, onCancel, busy, error,
}: {
  /** id the surrounding <Sheet> points aria-labelledby at. */
  labelId: string;
  taxonomy: Taxonomy;
  current: CategoryPair | null;
  heading: string;
  detail?: string;
  onPick: (pair: CategoryPair) => void;
  /** Adds the new category/subcategory; resolves to the pair to pick. */
  onCreate: (suggestion: CreateSuggestion) => Promise<CategoryPair | null>;
  onManage?: () => void;
  onCancel: () => void;
  busy?: boolean;
  error?: string | null;
}) {
  const headingId = labelId;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => searchTaxonomy(taxonomy, query), [taxonomy, query]);

  // Flattened, in visual order — what ↑/↓ walk through.
  const options = useMemo<Option[]>(() => {
    const out: Option[] = [];
    for (const g of groups) {
      out.push({ kind: "pick", pair: { category: g.category, subcategory: null } });
      for (const s of g.subcategories) out.push({ kind: "pick", pair: { category: g.category, subcategory: s } });
    }
    const activeOpt = active >= 0 ? out[active] : undefined;
    const contextCategory = activeOpt?.kind === "pick" ? activeOpt.pair.category : current?.category ?? null;
    for (const s of createSuggestions(taxonomy, query, contextCategory)) out.push({ kind: "create", suggestion: s });
    return out;
    // `active` only changes which category new subcategories default under.
  }, [groups, taxonomy, query, current, active]);

  const isCurrent = (pair: CategoryPair) =>
    !!current && current.category === pair.category && (current.subcategory ?? null) === pair.subcategory;
  const indexOf = (pair: CategoryPair) =>
    options.findIndex((o) => o.kind === "pick" && o.pair.category === pair.category && o.pair.subcategory === pair.subcategory);

  async function choose(option: Option | undefined) {
    if (!option || busy || creating) return;
    if (option.kind === "pick") { onPick(option.pair); return; }
    setCreating(true);
    setCreateError(null);
    try {
      const pair = await onCreate(option.suggestion);
      if (pair) onPick(pair);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Couldn't create it.");
    } finally {
      setCreating(false);
    }
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = active < 0 ? (step > 0 ? 0 : options.length - 1) : (active + step + options.length) % options.length;
      setActive(next);
      listRef.current?.querySelector<HTMLElement>(`[data-opt="${next}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      // Typing then Enter picks the best match even without arrowing.
      void choose(options[active >= 0 ? active : 0]);
    }
  }

  const activeId = (i: number) => (i === active ? "true" : undefined);
  const createOptions = options
    .map((o, i) => ({ o, i }))
    .filter((x): x is { o: Extract<Option, { kind: "create" }>; i: number } => x.o.kind === "create");

  return (
    <div className="cat-picker">
      <header className="cat-picker-head">
        <div className="min-w-0">
          <h2 id={headingId} className="cat-title">{heading}</h2>
          {detail && <p className="cat-detail">{detail}</p>}
        </div>
        <button type="button" className="cat-close" aria-label="Close" onClick={onCancel}>×</button>
      </header>

      <div className="cat-search">
        <input
          autoFocus
          type="search"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${headingId}-list`}
          aria-label="Search or create a category"
          placeholder="Search, or type a new name…  (e.g. coffee, dining / brunch)"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(-1); setCreateError(null); }}
          onKeyDown={onSearchKey}
        />
        {current && (
          <p className="cat-current">Now: <strong>{pairLabel(current.category, current.subcategory)}</strong></p>
        )}
      </div>

      {(error || createError) && <p className="cat-error" role="alert">{error || createError}</p>}

      <div ref={listRef} id={`${headingId}-list`} className="cat-grid" role="listbox" aria-label="Categories">
        {groups.map((g) => {
          const headIndex = indexOf({ category: g.category, subcategory: null });
          const headPair = { category: g.category, subcategory: null };
          return (
            <section key={g.category} className="cat-group">
              <button
                type="button"
                role="option"
                data-opt={headIndex}
                data-active={activeId(headIndex)}
                aria-selected={isCurrent(headPair)}
                className="cat-group-head"
                disabled={busy}
                onClick={() => choose({ kind: "pick", pair: headPair })}
                title={`${g.category} (no subcategory)`}
              >
                <span>{g.category}</span>
                {isCurrent(headPair) && <span aria-hidden="true" className="cat-check">✓</span>}
              </button>
              {g.subcategories.length > 0 && (
                <div className="cat-chips">
                  {g.subcategories.map((s) => {
                    const pair = { category: g.category, subcategory: s };
                    const i = indexOf(pair);
                    return (
                      <button
                        key={s}
                        type="button"
                        role="option"
                        data-opt={i}
                        data-active={activeId(i)}
                        aria-selected={isCurrent(pair)}
                        aria-label={pairLabel(g.category, s)}
                        className="cat-chip"
                        disabled={busy}
                        onClick={() => choose({ kind: "pick", pair })}
                      >
                        {s}{isCurrent(pair) && <span aria-hidden="true" className="cat-check">✓</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
        {groups.length === 0 && createOptions.length === 0 && (
          <p className="cat-empty">Nothing matches “{query}”.</p>
        )}
      </div>

      {createOptions.length > 0 && (
        <div className="cat-create">
          {createOptions.map(({ o, i }) => (
            <button
              key={i}
              type="button"
              data-opt={i}
              data-active={activeId(i)}
              disabled={busy || creating}
              onClick={() => choose(o)}
            >
              <span aria-hidden="true">＋</span>{" "}
              {o.suggestion.kind === "category"
                ? <>New category <strong>“{o.suggestion.category}”</strong></>
                : o.suggestion.newCategory
                  ? <>New <strong>“{o.suggestion.category} · {o.suggestion.subcategory}”</strong></>
                  : <>New <strong>“{o.suggestion.subcategory}”</strong> under {o.suggestion.category}</>}
            </button>
          ))}
        </div>
      )}

      <footer className="cat-foot">
        {onManage ? (
          <button type="button" className="cat-link" onClick={onManage}>Manage categories…</button>
        ) : <span />}
        <span className="cat-hint">{busy || creating ? "Saving…" : "↑↓ to move · Enter to pick · Esc to close"}</span>
      </footer>
    </div>
  );
}
