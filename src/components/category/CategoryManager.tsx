"use client";

import { useId, useState } from "react";
import {
  UNCATEGORIZED,
  aliasKey,
  normalizeName,
  pairLabel,
  type CategoryPair,
  type Taxonomy,
  type TaxonomyOp,
} from "@/lib/category-taxonomy";
import { TAXONOMY_MIGRATION } from "@/lib/category-taxonomy";
import MissingTableNotice from "../MissingTableNotice";
import Sheet from "./Sheet";

type Editing =
  | { kind: "rename"; category: string; subcategory?: string; value: string }
  | { kind: "delete"; category: string; subcategory?: string; target: string }
  | { kind: "add-sub"; category: string; value: string };

const NONE = "\u0000"; // separator inside <select> values

const encode = (p: CategoryPair) => `${p.category}${NONE}${p.subcategory ?? ""}`;
const decode = (v: string): CategoryPair => {
  const [category, sub] = v.split(NONE);
  return { category, subcategory: sub || null };
};

/**
 * Add, rename, merge, delete and reorder categories and subcategories.
 * Every change rewrites the matching transactions and merchant rules on the
 * server first, so nothing is ever left pointing at a name that's gone.
 */
export default function CategoryManager({ open, onClose, taxonomy, counts, tableMissing, runOp }: {
  open: boolean;
  onClose: () => void;
  taxonomy: Taxonomy;
  /** Transactions per aliasKey(category) and aliasKey(category, sub). */
  counts: ReadonlyMap<string, number>;
  tableMissing: boolean;
  /** Sends the op; resolves to a plain-English summary, throws on failure. */
  runOp: (op: TaxonomyOp) => Promise<string>;
}) {
  const labelId = useId();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [newCategory, setNewCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const count = (category: string, sub?: string) => counts.get(aliasKey(category, sub)) ?? 0;
  const exists = (name: string, within?: string) => {
    const n = name.toLowerCase();
    if (within) return taxonomy.find((c) => c.name === within)?.subcategories.some((s) => s.toLowerCase() === n) ?? false;
    return taxonomy.some((c) => c.name.toLowerCase() === n);
  };
  const exactName = (name: string, within?: string) =>
    within
      ? taxonomy.find((c) => c.name === within)?.subcategories.find((s) => s.toLowerCase() === name.toLowerCase())
      : taxonomy.find((c) => c.name.toLowerCase() === name.toLowerCase())?.name;

  async function run(op: TaxonomyOp) {
    setBusy(true);
    setNotice(null);
    try {
      const summary = await runOp(op);
      setNotice({ ok: true, text: summary });
      setEditing(null);
      return true;
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : "Couldn't save that change." });
      return false;
    } finally {
      setBusy(false);
    }
  }

  function submitRename(e: Extract<Editing, { kind: "rename" }>) {
    const typed = normalizeName(e.value);
    if (!typed) { setNotice({ ok: false, text: "Give it a name." }); return; }
    // Merging into an existing name uses its exact spelling.
    const to = exactName(typed, e.subcategory ? e.category : undefined) ?? typed;
    void run(e.subcategory
      ? { op: "rename_subcategory", category: e.category, from: e.subcategory, to }
      : { op: "rename_category", from: e.category, to });
  }

  function startDelete(category: string, subcategory?: string) {
    const target = subcategory
      ? encode({ category, subcategory: null })
      : encode({ category: UNCATEGORIZED, subcategory: null });
    setEditing({ kind: "delete", category, subcategory, target });
  }

  function destinations(category: string, subcategory?: string) {
    // A whole category can't move into itself; a subcategory can move to its parent.
    return taxonomy
      .filter((c) => subcategory ? true : c.name !== category)
      .map((c) => ({
        name: c.name,
        options: [
          { category: c.name, subcategory: null },
          ...c.subcategories
            .filter((s) => !(c.name === category && s === subcategory))
            .map((s) => ({ category: c.name, subcategory: s })),
        ],
      }));
  }

  const disabled = busy || tableMissing;
  const mergeHint = (e: Extract<Editing, { kind: "rename" }>) => {
    const typed = normalizeName(e.value);
    if (!typed) return null;
    const same = e.subcategory ? typed.toLowerCase() === e.subcategory.toLowerCase() : typed.toLowerCase() === e.category.toLowerCase();
    if (same) return null;
    if (exists(typed, e.subcategory ? e.category : undefined)) {
      return `“${exactName(typed, e.subcategory ? e.category : undefined)}” already exists — saving merges them.`;
    }
    return null;
  };

  return (
    <Sheet open={open} onClose={onClose} labelledBy={labelId} wide>
      <div className="cat-manager">
        <header className="cat-picker-head">
          <div className="min-w-0">
            <h2 id={labelId} className="cat-title">Your categories</h2>
            <p className="cat-detail">
              Rename, merge, delete or reorder. Changes apply to every transaction and merchant rule, and to future syncs.
            </p>
          </div>
          <button type="button" className="cat-close" aria-label="Close categories" onClick={onClose}>×</button>
        </header>

        {tableMissing && (
          <div className="px-5 pt-3">
            <MissingTableNotice
              feature="editing categories"
              migration={TAXONOMY_MIGRATION}
              what="Saving your own category list needs one new database table."
            />
          </div>
        )}

        {notice && (
          <p className={notice.ok ? "cat-ok" : "cat-error"} role={notice.ok ? "status" : "alert"}>{notice.text}</p>
        )}

        <form
          className="cat-add-row"
          onSubmit={async (ev) => {
            ev.preventDefault();
            if (await run({ op: "add_category", name: newCategory })) setNewCategory("");
          }}
        >
          <input
            aria-label="New category name"
            placeholder="New category name…"
            value={newCategory}
            maxLength={40}
            disabled={disabled}
            onChange={(e) => setNewCategory(e.target.value)}
          />
          <button type="submit" className="cat-btn cat-btn-primary" disabled={disabled || !newCategory.trim()}>Add category</button>
        </form>

        <ol className="cat-manage-list">
          {taxonomy.map((c, index) => {
            const isUnc = c.name === UNCATEGORIZED;
            const renaming = editing?.kind === "rename" && editing.category === c.name && !editing.subcategory ? editing : null;
            const deleting = editing?.kind === "delete" && editing.category === c.name && !editing.subcategory ? editing : null;
            const addingSub = editing?.kind === "add-sub" && editing.category === c.name ? editing : null;
            return (
              <li key={c.name} className="cat-manage-item">
                <div className="cat-manage-row">
                  {renaming ? (
                    <form className="cat-inline" onSubmit={(ev) => { ev.preventDefault(); submitRename(renaming); }}>
                      <input
                        autoFocus
                        aria-label={`New name for ${c.name}`}
                        value={renaming.value}
                        maxLength={40}
                        onChange={(e) => setEditing({ ...renaming, value: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); setEditing(null); } }}
                      />
                      <button type="submit" className="cat-btn cat-btn-primary" disabled={disabled}>Save</button>
                      <button type="button" className="cat-btn" onClick={() => setEditing(null)}>Cancel</button>
                      {mergeHint(renaming) && <small className="cat-merge-hint">{mergeHint(renaming)}</small>}
                    </form>
                  ) : (
                    <>
                      <span className="cat-manage-name">
                        <strong>{c.name}</strong>
                        <small>{count(c.name)} txn{count(c.name) === 1 ? "" : "s"}</small>
                      </span>
                      <span className="cat-manage-actions">
                        {!isUnc && (
                          <>
                            <button type="button" aria-label={`Move ${c.name} up`} disabled={disabled || index === 0}
                              onClick={() => run({ op: "move_category", name: c.name, direction: -1 })}>↑</button>
                            <button type="button" aria-label={`Move ${c.name} down`} disabled={disabled || index >= taxonomy.length - 2}
                              onClick={() => run({ op: "move_category", name: c.name, direction: 1 })}>↓</button>
                            <button type="button" disabled={disabled}
                              onClick={() => setEditing({ kind: "rename", category: c.name, value: c.name })}>Rename</button>
                            <button type="button" className="is-danger" disabled={disabled}
                              onClick={() => startDelete(c.name)}>Delete</button>
                          </>
                        )}
                        {isUnc && <small className="cat-muted">Always kept</small>}
                      </span>
                    </>
                  )}
                </div>

                {deleting && (
                  <DeletePanel
                    label={c.name}
                    moving={count(c.name)}
                    groups={destinations(c.name)}
                    target={deleting.target}
                    onTarget={(target) => setEditing({ ...deleting, target })}
                    onCancel={() => setEditing(null)}
                    onConfirm={() => run({ op: "delete_category", name: c.name, moveTo: decode(deleting.target) })}
                    busy={disabled}
                    extra={c.subcategories.length ? `Its ${c.subcategories.length} subcategor${c.subcategories.length === 1 ? "y goes" : "ies go"} too.` : undefined}
                  />
                )}

                {!isUnc && (
                  <ul className="cat-manage-subs">
                    {c.subcategories.map((s) => {
                      const subRename = editing?.kind === "rename" && editing.category === c.name && editing.subcategory === s ? editing : null;
                      const subDelete = editing?.kind === "delete" && editing.category === c.name && editing.subcategory === s ? editing : null;
                      return (
                        <li key={s}>
                          {subRename ? (
                            <form className="cat-inline" onSubmit={(ev) => { ev.preventDefault(); submitRename(subRename); }}>
                              <input
                                autoFocus
                                aria-label={`New name for ${pairLabel(c.name, s)}`}
                                value={subRename.value}
                                maxLength={40}
                                onChange={(e) => setEditing({ ...subRename, value: e.target.value })}
                                onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); setEditing(null); } }}
                              />
                              <button type="submit" className="cat-btn cat-btn-primary" disabled={disabled}>Save</button>
                              <button type="button" className="cat-btn" onClick={() => setEditing(null)}>Cancel</button>
                              {mergeHint(subRename) && <small className="cat-merge-hint">{mergeHint(subRename)}</small>}
                            </form>
                          ) : (
                            <div className="cat-manage-subrow">
                              <span>{s} <small>{count(c.name, s)}</small></span>
                              <span className="cat-manage-actions">
                                <button type="button" disabled={disabled}
                                  onClick={() => setEditing({ kind: "rename", category: c.name, subcategory: s, value: s })}>Rename</button>
                                <button type="button" className="is-danger" disabled={disabled}
                                  onClick={() => startDelete(c.name, s)}>Delete</button>
                              </span>
                            </div>
                          )}
                          {subDelete && (
                            <DeletePanel
                              label={pairLabel(c.name, s)}
                              moving={count(c.name, s)}
                              groups={destinations(c.name, s)}
                              target={subDelete.target}
                              onTarget={(target) => setEditing({ ...subDelete, target })}
                              onCancel={() => setEditing(null)}
                              onConfirm={() => run({ op: "delete_subcategory", category: c.name, name: s, moveTo: decode(subDelete.target) })}
                              busy={disabled}
                            />
                          )}
                        </li>
                      );
                    })}
                    <li>
                      {addingSub ? (
                        <form className="cat-inline" onSubmit={async (ev) => {
                          ev.preventDefault();
                          await run({ op: "add_subcategory", category: c.name, name: addingSub.value });
                        }}>
                          <input
                            autoFocus
                            aria-label={`New subcategory under ${c.name}`}
                            placeholder="Subcategory name…"
                            value={addingSub.value}
                            maxLength={40}
                            onChange={(e) => setEditing({ ...addingSub, value: e.target.value })}
                            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); setEditing(null); } }}
                          />
                          <button type="submit" className="cat-btn cat-btn-primary" disabled={disabled || !addingSub.value.trim()}>Add</button>
                          <button type="button" className="cat-btn" onClick={() => setEditing(null)}>Cancel</button>
                        </form>
                      ) : (
                        <button type="button" className="cat-link" disabled={disabled}
                          onClick={() => setEditing({ kind: "add-sub", category: c.name, value: "" })}>
                          + Add subcategory
                        </button>
                      )}
                    </li>
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </Sheet>
  );
}

function DeletePanel({ label, moving, groups, target, onTarget, onCancel, onConfirm, busy, extra }: {
  label: string;
  moving: number;
  groups: { name: string; options: CategoryPair[] }[];
  target: string;
  onTarget: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
  extra?: string;
}) {
  return (
    <div className="cat-delete" role="group" aria-label={`Delete ${label}`}>
      <p>
        Delete <strong>{label}</strong>?{" "}
        {moving > 0 ? <>Its {moving} transaction{moving === 1 ? "" : "s"} (and any merchant rules) will move to:</> : <>Any merchant rules using it will move to:</>}
        {extra && <> {extra}</>}
      </p>
      <select aria-label={`Move ${label} to`} value={target} onChange={(e) => onTarget(e.target.value)}>
        {groups.map((g) => (
          <optgroup key={g.name} label={g.name}>
            {g.options.map((o) => (
              <option key={encode(o)} value={encode(o)}>
                {o.subcategory ? `${g.name} · ${o.subcategory}` : `${g.name} (no subcategory)`}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <div className="cat-delete-actions">
        <button type="button" className="cat-btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="cat-btn cat-btn-danger" disabled={busy} onClick={onConfirm}>
          {moving > 0 ? `Delete and move ${moving}` : "Delete"}
        </button>
      </div>
    </div>
  );
}
