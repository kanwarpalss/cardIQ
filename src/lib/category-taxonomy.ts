/**
 * The user's category tree — the single place that decides which categories
 * and subcategories exist, and what happens to transactions when one is
 * renamed, merged or deleted (ARCH-04).
 *
 * Three layers, in priority order:
 *   1. the user's saved tree (`user_category_taxonomy.categories`, migration 025)
 *   2. otherwise the defaults in `categories.ts`
 *   3. plus any category/subcategory already sitting on a transaction or a
 *      merchant rule — so a value is never invisible just because it isn't
 *      in the tree.
 *
 * Renames and deletes also leave an ALIAS behind ("Dining" → "Food"), so the
 * keyword rules — which still emit default names — follow the user's rename
 * on every future sync instead of quietly resurrecting the old category.
 *
 * Everything here is pure: the API route loads/saves and executes the
 * `RowMove`s this module plans.
 */
import { CATEGORIES, SUBCATEGORIES } from "./categories";

export const UNCATEGORIZED = "Uncategorized";
export const MAX_NAME_LENGTH = 40;
/** The migration that creates user_category_taxonomy + category_manual. */
export const TAXONOMY_MIGRATION = "025_user_categories.sql";

export type CategoryNode = { name: string; subcategories: string[] };
export type Taxonomy = CategoryNode[];

/** A category, optionally narrowed to one subcategory. */
export type CategoryPair = { category: string; subcategory: string | null };

/**
 * Where a (category, subcategory) goes.
 * `subcategory: undefined` means "keep whatever subcategory it had".
 */
export type AliasTarget = { category: string; subcategory?: string | null };

/**
 * Key → target. Keys are `aliasKey(category)` (whole category) or
 * `aliasKey(category, subcategory)` (one subcategory).
 */
export type CategoryAliases = Record<string, AliasTarget>;

/**
 * One bulk rewrite the server runs against `transactions` AND
 * `merchant_mappings`. `from.subcategory: undefined` = any subcategory;
 * `null` = rows with no subcategory.
 */
export type RowMove = {
  from: { category: string; subcategory?: string | null };
  to: AliasTarget;
};

export type TaxonomyState = { taxonomy: Taxonomy; aliases: CategoryAliases };

export type TaxonomyOp =
  | { op: "add_category"; name: string }
  | { op: "add_subcategory"; category: string; name: string }
  | { op: "rename_category"; from: string; to: string }
  | { op: "rename_subcategory"; category: string; from: string; to: string }
  | { op: "delete_category"; name: string; moveTo: CategoryPair }
  | { op: "delete_subcategory"; category: string; name: string; moveTo: CategoryPair }
  | { op: "move_category"; name: string; direction: -1 | 1 };

export type OpResult =
  | { ok: true; state: TaxonomyState; moves: RowMove[]; summary: string }
  | { ok: false; error: string };

const SEP = "\u001f"; // never typed by a human, never valid in a name

export function aliasKey(category: string, subcategory?: string | null): string {
  return subcategory ? `${category}${SEP}${subcategory}` : category;
}

/** Display form used across the app: "Dining · Coffee" / "Dining". */
export function pairLabel(category: string, subcategory?: string | null): string {
  return subcategory ? `${category} · ${subcategory}` : category;
}

// ── Defaults + effective tree ───────────────────────────────────────────────

export function defaultTaxonomy(): Taxonomy {
  return CATEGORIES.map((name) => ({ name, subcategories: [...SUBCATEGORIES[name]] }));
}

function cloneTaxonomy(t: Taxonomy): Taxonomy {
  return t.map((n) => ({ name: n.name, subcategories: [...n.subcategories] }));
}

/** Uncategorized always exists and always sits last. */
function withUncategorizedLast(t: Taxonomy): Taxonomy {
  const rest = t.filter((n) => n.name !== UNCATEGORIZED);
  const unc = t.find((n) => n.name === UNCATEGORIZED) ?? { name: UNCATEGORIZED, subcategories: [] };
  return [...rest, unc];
}

/**
 * Accepts anything that came back from the DB/network and returns a clean
 * tree (or null when it isn't one). Drops blanks and duplicates rather than
 * failing — a malformed row must not blank the Spend screen.
 */
export function sanitizeTaxonomy(raw: unknown): Taxonomy | null {
  if (!Array.isArray(raw)) return null;
  const out: Taxonomy = [];
  const seen = new Set<string>();
  for (const node of raw) {
    if (!node || typeof node !== "object") continue;
    const name = normalizeName((node as { name?: unknown }).name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const subsRaw = (node as { subcategories?: unknown }).subcategories;
    const subs: string[] = [];
    if (Array.isArray(subsRaw)) {
      for (const s of subsRaw) {
        const sub = normalizeName(s);
        if (sub && !subs.includes(sub)) subs.push(sub);
      }
    }
    out.push({ name, subcategories: subs });
  }
  return out.length ? out : null;
}

export function sanitizeAliases(raw: unknown): CategoryAliases {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: CategoryAliases = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const category = normalizeName((value as { category?: unknown }).category);
    if (!category) continue;
    const subRaw = (value as { subcategory?: unknown }).subcategory;
    const target: AliasTarget = { category };
    if (subRaw === null) target.subcategory = null;
    else if (typeof subRaw === "string") target.subcategory = normalizeName(subRaw);
    out[key] = target;
  }
  return out;
}

/**
 * The tree every screen shows: saved (or default) tree, plus every value
 * actually in use. Observed values are appended in the order first seen so
 * the user's own ordering is never disturbed.
 */
export function effectiveTaxonomy(
  stored: Taxonomy | null,
  observed: Iterable<{ category: string | null; subcategory?: string | null }>,
): Taxonomy {
  const tree = cloneTaxonomy(stored ?? defaultTaxonomy());
  const byName = new Map(tree.map((n) => [n.name, n]));
  for (const row of observed) {
    const cat = row.category?.trim() || UNCATEGORIZED;
    let node = byName.get(cat);
    if (!node) {
      node = { name: cat, subcategories: [] };
      tree.push(node);
      byName.set(cat, node);
    }
    const sub = row.subcategory?.trim();
    if (sub && !node.subcategories.includes(sub)) node.subcategories.push(sub);
  }
  return withUncategorizedLast(tree);
}

/** Legacy shape the filter panel still consumes. */
export function subcategoryMap(t: Taxonomy): Record<string, string[]> {
  return Object.fromEntries(t.map((n) => [n.name, [...n.subcategories]]));
}

// ── Names ───────────────────────────────────────────────────────────────────

/** Trim, collapse spaces, cap length. Null when nothing usable remains. */
export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
   
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_NAME_LENGTH).trim();
}

// ── Aliases ─────────────────────────────────────────────────────────────────

/**
 * Follow aliases until none applies. A pair alias ("Dining·Coffee") beats a
 * whole-category alias ("Dining"). Cycles stop at the first repeat, so a
 * corrupted alias table can never hang a sync.
 */
export function resolveAlias(pair: CategoryPair, aliases: CategoryAliases): CategoryPair {
  let { category, subcategory } = pair;
  const seen = new Set<string>();
  for (let hop = 0; hop < 16; hop++) {
    const key = aliasKey(category, subcategory);
    if (seen.has(key)) break;
    seen.add(key);
    const hit = (subcategory ? aliases[aliasKey(category, subcategory)] : undefined) ?? aliases[category];
    if (!hit) break;
    const nextSub = hit.subcategory === undefined ? subcategory : hit.subcategory;
    if (hit.category === category && nextSub === subcategory) break;
    category = hit.category;
    subcategory = nextSub ?? null;
  }
  return { category, subcategory };
}

/** A name the user (re)claims stops being an alias for something else. */
function releaseAliases(aliases: CategoryAliases, category: string, subcategory?: string): CategoryAliases {
  const next = { ...aliases };
  if (subcategory) {
    delete next[aliasKey(category, subcategory)];
  } else {
    delete next[category];
    for (const key of Object.keys(next)) if (key.startsWith(category + SEP)) delete next[key];
  }
  return next;
}

// ── Operations ──────────────────────────────────────────────────────────────

function fail(error: string): OpResult {
  return { ok: false, error };
}

function findNode(t: Taxonomy, name: string): CategoryNode | undefined {
  return t.find((n) => n.name === name);
}

function validTarget(t: Taxonomy, target: CategoryPair): string | null {
  const node = findNode(t, target.category);
  if (!node) return `“${target.category}” isn't one of your categories.`;
  if (target.subcategory && !node.subcategories.includes(target.subcategory)) {
    return `“${pairLabel(target.category, target.subcategory)}” doesn't exist.`;
  }
  return null;
}

/**
 * Apply one edit to the tree. Returns the new tree + aliases and the row
 * rewrites the server must run so existing transactions and merchant rules
 * agree with it. Never mutates its input.
 */
export function applyTaxonomyOp(state: TaxonomyState, op: TaxonomyOp): OpResult {
  const taxonomy = withUncategorizedLast(cloneTaxonomy(state.taxonomy));
  let aliases = { ...state.aliases };

  switch (op.op) {
    case "add_category": {
      const name = normalizeName(op.name);
      if (!name) return fail("Give the category a name.");
      if (findNode(taxonomy, name)) return fail(`“${name}” already exists.`);
      taxonomy.splice(taxonomy.length - 1, 0, { name, subcategories: [] }); // before Uncategorized
      aliases = releaseAliases(aliases, name);
      return { ok: true, state: { taxonomy, aliases }, moves: [], summary: `Added “${name}”.` };
    }

    case "add_subcategory": {
      const name = normalizeName(op.name);
      if (!name) return fail("Give the subcategory a name.");
      const node = findNode(taxonomy, op.category);
      if (!node) return fail(`“${op.category}” isn't one of your categories.`);
      if (node.subcategories.includes(name)) return fail(`“${pairLabel(node.name, name)}” already exists.`);
      node.subcategories.push(name);
      aliases = releaseAliases(aliases, node.name, name);
      return { ok: true, state: { taxonomy, aliases }, moves: [], summary: `Added “${pairLabel(node.name, name)}”.` };
    }

    case "rename_category": {
      const to = normalizeName(op.to);
      if (!to) return fail("Give the category a name.");
      if (op.from === UNCATEGORIZED) return fail("“Uncategorized” can't be renamed.");
      if (to === UNCATEGORIZED) return fail("To empty a category into Uncategorized, delete it instead.");
      const node = findNode(taxonomy, op.from);
      if (!node) return fail(`“${op.from}” isn't one of your categories.`);
      if (to === op.from) return fail("That's already its name.");
      const existing = findNode(taxonomy, to);
      if (existing) {
        // Merge: subcategories carry over, original order of the survivor kept.
        for (const s of node.subcategories) if (!existing.subcategories.includes(s)) existing.subcategories.push(s);
        taxonomy.splice(taxonomy.indexOf(node), 1);
      } else {
        node.name = to;
      }
      aliases = releaseAliases(aliases, to);
      aliases[op.from] = { category: to };
      return {
        ok: true,
        state: { taxonomy, aliases },
        moves: [{ from: { category: op.from }, to: { category: to } }],
        summary: existing ? `Merged “${op.from}” into “${to}”.` : `Renamed “${op.from}” to “${to}”.`,
      };
    }

    case "rename_subcategory": {
      const to = normalizeName(op.to);
      if (!to) return fail("Give the subcategory a name.");
      const node = findNode(taxonomy, op.category);
      if (!node) return fail(`“${op.category}” isn't one of your categories.`);
      const idx = node.subcategories.indexOf(op.from);
      if (idx < 0) return fail(`“${pairLabel(op.category, op.from)}” doesn't exist.`);
      if (to === op.from) return fail("That's already its name.");
      const merging = node.subcategories.includes(to);
      if (merging) node.subcategories.splice(idx, 1);
      else node.subcategories[idx] = to;
      aliases = releaseAliases(aliases, node.name, to);
      aliases[aliasKey(node.name, op.from)] = { category: node.name, subcategory: to };
      return {
        ok: true,
        state: { taxonomy, aliases },
        moves: [{ from: { category: node.name, subcategory: op.from }, to: { category: node.name, subcategory: to } }],
        summary: merging
          ? `Merged “${pairLabel(node.name, op.from)}” into “${pairLabel(node.name, to)}”.`
          : `Renamed “${pairLabel(node.name, op.from)}” to “${pairLabel(node.name, to)}”.`,
      };
    }

    case "delete_category": {
      if (op.name === UNCATEGORIZED) return fail("“Uncategorized” can't be deleted — it's where unsorted spends live.");
      const node = findNode(taxonomy, op.name);
      if (!node) return fail(`“${op.name}” isn't one of your categories.`);
      if (op.moveTo.category === op.name) return fail("Pick a different category to move its transactions to.");
      const targetError = validTarget(taxonomy, op.moveTo);
      if (targetError) return fail(targetError);
      taxonomy.splice(taxonomy.indexOf(node), 1);
      const to: AliasTarget = { category: op.moveTo.category, subcategory: op.moveTo.subcategory ?? null };
      aliases[op.name] = to;
      // Pair aliases under the deleted category would outrank the new
      // whole-category alias and point at a category that no longer exists.
      for (const key of Object.keys(aliases)) if (key.startsWith(op.name + SEP)) aliases[key] = to;
      return {
        ok: true,
        state: { taxonomy, aliases },
        moves: [{ from: { category: op.name }, to }],
        summary: `Deleted “${op.name}”; its transactions moved to “${pairLabel(to.category, to.subcategory)}”.`,
      };
    }

    case "delete_subcategory": {
      const node = findNode(taxonomy, op.category);
      if (!node) return fail(`“${op.category}” isn't one of your categories.`);
      const idx = node.subcategories.indexOf(op.name);
      if (idx < 0) return fail(`“${pairLabel(op.category, op.name)}” doesn't exist.`);
      if (op.moveTo.category === op.category && op.moveTo.subcategory === op.name) {
        return fail("Pick a different place to move its transactions to.");
      }
      const targetError = validTarget(taxonomy, op.moveTo);
      if (targetError) return fail(targetError);
      node.subcategories.splice(idx, 1);
      const to: AliasTarget = { category: op.moveTo.category, subcategory: op.moveTo.subcategory ?? null };
      aliases[aliasKey(op.category, op.name)] = to;
      return {
        ok: true,
        state: { taxonomy, aliases },
        moves: [{ from: { category: op.category, subcategory: op.name }, to }],
        summary: `Deleted “${pairLabel(op.category, op.name)}”; its transactions moved to “${pairLabel(to.category, to.subcategory)}”.`,
      };
    }

    case "move_category": {
      const idx = taxonomy.findIndex((n) => n.name === op.name);
      if (idx < 0) return fail(`“${op.name}” isn't one of your categories.`);
      const swap = idx + op.direction;
      // Uncategorized is pinned last; nothing swaps with it.
      if (op.name === UNCATEGORIZED || swap < 0 || swap >= taxonomy.length - 1) {
        return { ok: true, state: { taxonomy, aliases }, moves: [], summary: "Order unchanged." };
      }
      [taxonomy[idx], taxonomy[swap]] = [taxonomy[swap], taxonomy[idx]];
      return { ok: true, state: { taxonomy, aliases }, moves: [], summary: `Moved “${op.name}”.` };
    }
  }
}

/** Parse an untrusted request body into a TaxonomyOp (null when malformed). */
export function parseTaxonomyOp(body: unknown): TaxonomyOp | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const pair = (v: unknown): CategoryPair | null => {
    if (!v || typeof v !== "object") return null;
    const category = str((v as Record<string, unknown>).category);
    const sub = (v as Record<string, unknown>).subcategory;
    if (!category) return null;
    return { category, subcategory: typeof sub === "string" && sub.trim() ? sub : null };
  };
  switch (b.op) {
    case "add_category":
      return str(b.name) !== null ? { op: "add_category", name: b.name as string } : null;
    case "add_subcategory":
      return str(b.category) && str(b.name) !== null ? { op: "add_subcategory", category: b.category as string, name: b.name as string } : null;
    case "rename_category":
      return str(b.from) && str(b.to) !== null ? { op: "rename_category", from: b.from as string, to: b.to as string } : null;
    case "rename_subcategory":
      return str(b.category) && str(b.from) && str(b.to) !== null
        ? { op: "rename_subcategory", category: b.category as string, from: b.from as string, to: b.to as string }
        : null;
    case "delete_category": {
      const moveTo = pair(b.moveTo);
      return str(b.name) && moveTo ? { op: "delete_category", name: b.name as string, moveTo } : null;
    }
    case "delete_subcategory": {
      const moveTo = pair(b.moveTo);
      return str(b.category) && str(b.name) && moveTo
        ? { op: "delete_subcategory", category: b.category as string, name: b.name as string, moveTo }
        : null;
    }
    case "move_category":
      return str(b.name) && (b.direction === 1 || b.direction === -1)
        ? { op: "move_category", name: b.name as string, direction: b.direction }
        : null;
    default:
      return null;
  }
}

// ── Assigning a category to a transaction ───────────────────────────────────

/**
 * The ONE rule every email→transaction path uses: an explicit merchant rule
 * wins wholesale (including a deliberate lack of subcategory); otherwise the
 * keyword rules decide. Either way the user's renames/deletes are applied on
 * top, so a renamed category never comes back from a sync.
 */
export function resolveTxnCategory(
  mapping: { category?: string | null; subcategory?: string | null } | null | undefined,
  ruled: CategoryPair,
  aliases: CategoryAliases,
): CategoryPair {
  const base: CategoryPair = mapping?.category
    ? { category: mapping.category, subcategory: mapping.subcategory ?? null }
    : ruled;
  return resolveAlias(base, aliases);
}

// ── Picker search ───────────────────────────────────────────────────────────

export type PickerGroup = { category: string; categoryMatches: boolean; subcategories: string[] };

const SPLIT = /\s*(?:\/|›|>|·)\s*/;

/**
 * Filter the tree for the picker's search box.
 *   ""            → everything
 *   "din"         → Dining with all its subcategories
 *   "coff"        → Dining, showing only Coffee
 *   "dining/cof"  → same, scoped to Dining
 */
export function searchTaxonomy(t: Taxonomy, query: string): PickerGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return t.map((n) => ({ category: n.name, categoryMatches: true, subcategories: [...n.subcategories] }));
  const [catPart, subPart] = q.split(SPLIT, 2);
  const out: PickerGroup[] = [];
  for (const n of t) {
    const name = n.name.toLowerCase();
    if (subPart !== undefined) {
      if (!name.includes(catPart)) continue;
      const subs = n.subcategories.filter((s) => s.toLowerCase().includes(subPart));
      if (subs.length || !subPart) out.push({ category: n.name, categoryMatches: true, subcategories: subPart ? subs : [...n.subcategories] });
      continue;
    }
    if (name.includes(q)) {
      out.push({ category: n.name, categoryMatches: true, subcategories: [...n.subcategories] });
      continue;
    }
    const subs = n.subcategories.filter((s) => s.toLowerCase().includes(q));
    if (subs.length) out.push({ category: n.name, categoryMatches: false, subcategories: subs });
  }
  // Exact/prefix hits first so Enter picks the obvious one.
  const rank = (g: PickerGroup) => {
    const name = g.category.toLowerCase();
    if (name === q) return 0;
    if (g.subcategories.some((s) => s.toLowerCase() === q)) return 1;
    if (name.startsWith(q)) return 2;
    if (g.subcategories.some((s) => s.toLowerCase().startsWith(q))) return 3;
    return 4;
  };
  return out.map((g, i) => ({ g, i })).sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i).map(({ g }) => g);
}

export type CreateSuggestion =
  | { kind: "category"; category: string }
  | { kind: "subcategory"; category: string; subcategory: string; newCategory: boolean };

/**
 * What "+ Create …" rows the picker offers for the typed text. Nothing is
 * offered when the text already names an existing option exactly.
 * `contextCategory` = the category the user is most likely adding under
 * (the highlighted group, else the transaction's current category).
 */
export function createSuggestions(t: Taxonomy, query: string, contextCategory: string | null): CreateSuggestion[] {
  const raw = query.trim();
  if (!raw) return [];
  const parts = raw.split(SPLIT);
  const findCat = (name: string) => t.find((n) => n.name.toLowerCase() === name.toLowerCase());

  if (parts.length >= 2) {
    const catName = normalizeName(parts[0]);
    const subName = normalizeName(parts.slice(1).join(" "));
    if (!catName || !subName) return [];
    const cat = findCat(catName);
    if (cat?.subcategories.some((s) => s.toLowerCase() === subName.toLowerCase())) return [];
    return [{ kind: "subcategory", category: cat?.name ?? catName, subcategory: subName, newCategory: !cat }];
  }

  const name = normalizeName(raw);
  if (!name) return [];
  const out: CreateSuggestion[] = [];
  if (!findCat(name)) out.push({ kind: "category", category: name });
  const ctx = contextCategory ? findCat(contextCategory) : undefined;
  if (ctx && ctx.name !== UNCATEGORIZED && ctx.name.toLowerCase() !== name.toLowerCase()
      && !ctx.subcategories.some((s) => s.toLowerCase() === name.toLowerCase())) {
    out.push({ kind: "subcategory", category: ctx.name, subcategory: name, newCategory: false });
  }
  return out;
}
