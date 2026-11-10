import { describe, expect, it } from "vitest";
import {
  UNCATEGORIZED,
  aliasKey,
  applyTaxonomyOp,
  createSuggestions,
  defaultTaxonomy,
  effectiveTaxonomy,
  normalizeName,
  parseTaxonomyOp,
  resolveAlias,
  resolveTxnCategory,
  sanitizeAliases,
  sanitizeTaxonomy,
  searchTaxonomy,
  type TaxonomyState,
} from "./category-taxonomy";

const tree = () => [
  { name: "Dining", subcategories: ["Coffee", "Restaurants"] },
  { name: "Transport", subcategories: ["Cabs"] },
  { name: UNCATEGORIZED, subcategories: [] },
];
const state = (): TaxonomyState => ({ taxonomy: tree(), aliases: {} });

function ok(result: ReturnType<typeof applyTaxonomyOp>) {
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("effectiveTaxonomy", () => {
  it("falls back to the defaults and keeps Uncategorized last", () => {
    const t = effectiveTaxonomy(null, []);
    expect(t.map((n) => n.name)).toEqual(defaultTaxonomy().map((n) => n.name));
    expect(t.at(-1)!.name).toBe(UNCATEGORIZED);
  });

  it("surfaces values in use that the tree doesn't know, without reordering the tree", () => {
    const t = effectiveTaxonomy(tree(), [
      { category: "Gifts", subcategory: "Birthdays" },
      { category: "Dining", subcategory: "Brunch" },
      { category: null, subcategory: null },
      { category: "  ", subcategory: "" },
    ]);
    expect(t.map((n) => n.name)).toEqual(["Dining", "Transport", "Gifts", UNCATEGORIZED]);
    expect(t[0].subcategories).toEqual(["Coffee", "Restaurants", "Brunch"]);
    expect(t[2].subcategories).toEqual(["Birthdays"]);
  });

  it("adds Uncategorized when a saved tree lacks it, and never mutates the saved tree", () => {
    const saved = [{ name: "Dining", subcategories: [] }];
    const t = effectiveTaxonomy(saved, [{ category: "Dining", subcategory: "Coffee" }]);
    expect(t.map((n) => n.name)).toEqual(["Dining", UNCATEGORIZED]);
    expect(saved[0].subcategories).toEqual([]);
  });
});

describe("sanitize", () => {
  it("drops junk, blanks and duplicates instead of failing", () => {
    expect(sanitizeTaxonomy("nope")).toBeNull();
    expect(sanitizeTaxonomy([])).toBeNull();
    expect(sanitizeTaxonomy([null, { name: "  " }, { name: "A", subcategories: ["x", "x", 3, " "] }, { name: "A" }]))
      .toEqual([{ name: "A", subcategories: ["x"] }]);
  });

  it("keeps the difference between 'keep subcategory' and 'no subcategory' in aliases", () => {
    const a = sanitizeAliases({ Fuel: { category: "Transport", subcategory: "Fuel" }, X: { category: "Y" }, Z: { category: "W", subcategory: null }, bad: 3 });
    expect(a).toEqual({ Fuel: { category: "Transport", subcategory: "Fuel" }, X: { category: "Y" }, Z: { category: "W", subcategory: null } });
    expect("subcategory" in a.X).toBe(false);
  });
});

describe("normalizeName", () => {
  it("trims, collapses whitespace, strips control chars and caps length", () => {
    expect(normalizeName("  Eating   out ")).toBe("Eating out");
    expect(normalizeName("a\u001fb")).toBe("a b");
    expect(normalizeName("x".repeat(60))!.length).toBe(40);
    expect(normalizeName("   ")).toBeNull();
    expect(normalizeName(42)).toBeNull();
  });
});

describe("applyTaxonomyOp", () => {
  it("adds a category just before Uncategorized and rejects duplicates", () => {
    const r = ok(applyTaxonomyOp(state(), { op: "add_category", name: " Gifts " }));
    expect(r.state.taxonomy.map((n) => n.name)).toEqual(["Dining", "Transport", "Gifts", UNCATEGORIZED]);
    expect(r.moves).toEqual([]);
    expect(applyTaxonomyOp(state(), { op: "add_category", name: "Dining" })).toEqual({ ok: false, error: "“Dining” already exists." });
  });

  it("adds a subcategory and rejects one that exists", () => {
    const r = ok(applyTaxonomyOp(state(), { op: "add_subcategory", category: "Dining", name: "Brunch" }));
    expect(r.state.taxonomy[0].subcategories).toEqual(["Coffee", "Restaurants", "Brunch"]);
    expect(applyTaxonomyOp(state(), { op: "add_subcategory", category: "Dining", name: "Coffee" }).ok).toBe(false);
    expect(applyTaxonomyOp(state(), { op: "add_subcategory", category: "Nope", name: "x" }).ok).toBe(false);
  });

  it("renames a category, moves every row (any subcategory, kept) and leaves an alias", () => {
    const r = ok(applyTaxonomyOp(state(), { op: "rename_category", from: "Dining", to: "Food" }));
    expect(r.state.taxonomy[0]).toEqual({ name: "Food", subcategories: ["Coffee", "Restaurants"] });
    expect(r.moves).toEqual([{ from: { category: "Dining" }, to: { category: "Food" } }]);
    expect(resolveAlias({ category: "Dining", subcategory: "Coffee" }, r.state.aliases)).toEqual({ category: "Food", subcategory: "Coffee" });
  });

  it("renaming onto an existing category merges subcategories instead of duplicating it", () => {
    const r = ok(applyTaxonomyOp(state(), { op: "rename_category", from: "Transport", to: "Dining" }));
    expect(r.state.taxonomy.map((n) => n.name)).toEqual(["Dining", UNCATEGORIZED]);
    expect(r.state.taxonomy[0].subcategories).toEqual(["Coffee", "Restaurants", "Cabs"]);
    expect(r.summary).toMatch(/Merged/);
  });

  it("protects Uncategorized", () => {
    expect(applyTaxonomyOp(state(), { op: "rename_category", from: UNCATEGORIZED, to: "Misc" }).ok).toBe(false);
    expect(applyTaxonomyOp(state(), { op: "rename_category", from: "Dining", to: UNCATEGORIZED }).ok).toBe(false);
    expect(applyTaxonomyOp(state(), { op: "delete_category", name: UNCATEGORIZED, moveTo: { category: "Dining", subcategory: null } }).ok).toBe(false);
    const moved = ok(applyTaxonomyOp(state(), { op: "move_category", name: "Transport", direction: 1 }));
    expect(moved.state.taxonomy.at(-1)!.name).toBe(UNCATEGORIZED);
  });

  it("renames back and forth without creating an alias loop", () => {
    const a = ok(applyTaxonomyOp(state(), { op: "rename_category", from: "Dining", to: "Food" }));
    const b = ok(applyTaxonomyOp(a.state, { op: "rename_category", from: "Food", to: "Dining" }));
    expect(b.state.taxonomy[0].name).toBe("Dining");
    expect(resolveAlias({ category: "Dining", subcategory: "Coffee" }, b.state.aliases)).toEqual({ category: "Dining", subcategory: "Coffee" });
    expect(resolveAlias({ category: "Food", subcategory: null }, b.state.aliases)).toEqual({ category: "Dining", subcategory: null });
  });

  it("re-adding a renamed-away name reclaims it from the alias", () => {
    const a = ok(applyTaxonomyOp(state(), { op: "rename_category", from: "Dining", to: "Food" }));
    const b = ok(applyTaxonomyOp(a.state, { op: "add_category", name: "Dining" }));
    expect(resolveAlias({ category: "Dining", subcategory: null }, b.state.aliases).category).toBe("Dining");
  });

  it("renames and merges subcategories, scoped to their category", () => {
    const r = ok(applyTaxonomyOp(state(), { op: "rename_subcategory", category: "Dining", from: "Coffee", to: "Cafés" }));
    expect(r.state.taxonomy[0].subcategories).toEqual(["Cafés", "Restaurants"]);
    expect(r.moves).toEqual([{ from: { category: "Dining", subcategory: "Coffee" }, to: { category: "Dining", subcategory: "Cafés" } }]);
    const m = ok(applyTaxonomyOp(state(), { op: "rename_subcategory", category: "Dining", from: "Coffee", to: "Restaurants" }));
    expect(m.state.taxonomy[0].subcategories).toEqual(["Restaurants"]);
    // A "Coffee" under some other category is untouched by the alias.
    expect(resolveAlias({ category: "Transport", subcategory: "Coffee" }, r.state.aliases)).toEqual({ category: "Transport", subcategory: "Coffee" });
  });

  it("deletes a category into an exact destination, including its subcategories", () => {
    const r = ok(applyTaxonomyOp(state(), { op: "delete_category", name: "Dining", moveTo: { category: "Transport", subcategory: "Cabs" } }));
    expect(r.state.taxonomy.map((n) => n.name)).toEqual(["Transport", UNCATEGORIZED]);
    expect(r.moves).toEqual([{ from: { category: "Dining" }, to: { category: "Transport", subcategory: "Cabs" } }]);
    expect(resolveAlias({ category: "Dining", subcategory: "Coffee" }, r.state.aliases)).toEqual({ category: "Transport", subcategory: "Cabs" });
  });

  it("a delete outranks an earlier subcategory rename under the same category", () => {
    const a = ok(applyTaxonomyOp(state(), { op: "rename_subcategory", category: "Dining", from: "Coffee", to: "Cafés" }));
    const b = ok(applyTaxonomyOp(a.state, { op: "delete_category", name: "Dining", moveTo: { category: UNCATEGORIZED, subcategory: null } }));
    expect(resolveAlias({ category: "Dining", subcategory: "Coffee" }, b.state.aliases)).toEqual({ category: UNCATEGORIZED, subcategory: null });
  });

  it("refuses a delete that moves into itself or into something that doesn't exist", () => {
    expect(applyTaxonomyOp(state(), { op: "delete_category", name: "Dining", moveTo: { category: "Dining", subcategory: "Coffee" } }).ok).toBe(false);
    expect(applyTaxonomyOp(state(), { op: "delete_category", name: "Dining", moveTo: { category: "Ghost", subcategory: null } }).ok).toBe(false);
    expect(applyTaxonomyOp(state(), { op: "delete_category", name: "Dining", moveTo: { category: "Transport", subcategory: "Ghost" } }).ok).toBe(false);
    expect(applyTaxonomyOp(state(), { op: "delete_subcategory", category: "Dining", name: "Coffee", moveTo: { category: "Dining", subcategory: "Coffee" } }).ok).toBe(false);
  });

  it("deletes a subcategory back into its parent", () => {
    const r = ok(applyTaxonomyOp(state(), { op: "delete_subcategory", category: "Dining", name: "Coffee", moveTo: { category: "Dining", subcategory: null } }));
    expect(r.state.taxonomy[0].subcategories).toEqual(["Restaurants"]);
    expect(r.moves).toEqual([{ from: { category: "Dining", subcategory: "Coffee" }, to: { category: "Dining", subcategory: null } }]);
  });

  it("reorders, and clamps at the edges", () => {
    const r = ok(applyTaxonomyOp(state(), { op: "move_category", name: "Transport", direction: -1 }));
    expect(r.state.taxonomy.map((n) => n.name)).toEqual(["Transport", "Dining", UNCATEGORIZED]);
    const edge = ok(applyTaxonomyOp(state(), { op: "move_category", name: "Dining", direction: -1 }));
    expect(edge.state.taxonomy.map((n) => n.name)).toEqual(["Dining", "Transport", UNCATEGORIZED]);
  });

  it("never mutates the input state", () => {
    const s = state();
    const snapshot = JSON.stringify(s);
    applyTaxonomyOp(s, { op: "rename_category", from: "Dining", to: "Food" });
    applyTaxonomyOp(s, { op: "delete_subcategory", category: "Dining", name: "Coffee", moveTo: { category: "Dining", subcategory: null } });
    expect(JSON.stringify(s)).toBe(snapshot);
  });
});

describe("resolveAlias", () => {
  it("follows chains and survives a corrupted cycle", () => {
    expect(resolveAlias({ category: "A", subcategory: null }, { A: { category: "B" }, B: { category: "C" } })).toEqual({ category: "C", subcategory: null });
    const cyc = resolveAlias({ category: "A", subcategory: null }, { A: { category: "B" }, B: { category: "A" } });
    expect(["A", "B"]).toContain(cyc.category);
  });

  it("prefers the subcategory alias over the whole-category alias", () => {
    const aliases = { Utilities: { category: "Home & Bills" }, [aliasKey("Utilities", "FASTag")]: { category: "Transport", subcategory: "FASTag" } };
    expect(resolveAlias({ category: "Utilities", subcategory: "FASTag" }, aliases)).toEqual({ category: "Transport", subcategory: "FASTag" });
    expect(resolveAlias({ category: "Utilities", subcategory: "DTH" }, aliases)).toEqual({ category: "Home & Bills", subcategory: "DTH" });
  });
});

describe("resolveTxnCategory", () => {
  const aliases = { Dining: { category: "Food" } };
  it("lets a merchant rule win wholesale, including a deliberate empty subcategory", () => {
    expect(resolveTxnCategory({ category: "Travel", subcategory: null }, { category: "Dining", subcategory: "Coffee" }, {}))
      .toEqual({ category: "Travel", subcategory: null });
  });
  it("applies renames to keyword-rule output and to stale merchant rules", () => {
    expect(resolveTxnCategory(null, { category: "Dining", subcategory: "Coffee" }, aliases)).toEqual({ category: "Food", subcategory: "Coffee" });
    expect(resolveTxnCategory({ category: "Dining" }, { category: "Shopping", subcategory: null }, aliases)).toEqual({ category: "Food", subcategory: null });
  });
  it("ignores a mapping with no category", () => {
    expect(resolveTxnCategory({ category: null }, { category: "Dining", subcategory: null }, {})).toEqual({ category: "Dining", subcategory: null });
  });
});

describe("parseTaxonomyOp", () => {
  it("accepts well-formed ops and rejects malformed ones", () => {
    expect(parseTaxonomyOp({ op: "add_category", name: "X" })).toEqual({ op: "add_category", name: "X" });
    expect(parseTaxonomyOp({ op: "delete_category", name: "X", moveTo: { category: "Y", subcategory: "" } }))
      .toEqual({ op: "delete_category", name: "X", moveTo: { category: "Y", subcategory: null } });
    expect(parseTaxonomyOp({ op: "move_category", name: "X", direction: 2 })).toBeNull();
    expect(parseTaxonomyOp({ op: "delete_category", name: "X" })).toBeNull();
    expect(parseTaxonomyOp({ op: "drop_table" })).toBeNull();
    expect(parseTaxonomyOp(null)).toBeNull();
  });
});

describe("searchTaxonomy", () => {
  const t = tree();
  it("shows everything for an empty query", () => {
    expect(searchTaxonomy(t, "  ").map((g) => g.category)).toEqual(["Dining", "Transport", UNCATEGORIZED]);
  });
  it("a category hit shows all its subcategories; a subcategory hit shows only matches", () => {
    expect(searchTaxonomy(t, "din")).toEqual([{ category: "Dining", categoryMatches: true, subcategories: ["Coffee", "Restaurants"] }]);
    expect(searchTaxonomy(t, "COF")).toEqual([{ category: "Dining", categoryMatches: false, subcategories: ["Coffee"] }]);
  });
  it("supports 'category / subcategory' scoping", () => {
    expect(searchTaxonomy(t, "dining/res")).toEqual([{ category: "Dining", categoryMatches: true, subcategories: ["Restaurants"] }]);
    expect(searchTaxonomy(t, "trans › cof")).toEqual([]);
  });
  it("ranks exact and prefix hits first", () => {
    const t2 = [{ name: "Cabs & More", subcategories: [] }, { name: "Transport", subcategories: ["Cabs"] }];
    expect(searchTaxonomy(t2, "cabs")[0].category).toBe("Transport");
  });
});

describe("createSuggestions", () => {
  const t = tree();
  it("offers a new category and a new subcategory under the context category", () => {
    expect(createSuggestions(t, "Brunch", "Dining")).toEqual([
      { kind: "category", category: "Brunch" },
      { kind: "subcategory", category: "Dining", subcategory: "Brunch", newCategory: false },
    ]);
  });
  it("offers nothing when the text already names an option (case-insensitively)", () => {
    expect(createSuggestions(t, "dining", "Dining")).toEqual([]);
    expect(createSuggestions(t, "coffee", "Dining")).toEqual([{ kind: "category", category: "coffee" }]);
    expect(createSuggestions(t, "dining / coffee", null)).toEqual([]);
  });
  it("never offers a subcategory under Uncategorized", () => {
    expect(createSuggestions(t, "Misc", UNCATEGORIZED)).toEqual([{ kind: "category", category: "Misc" }]);
  });
  it("parses 'Category / Sub', including a brand-new category", () => {
    expect(createSuggestions(t, "dining / Brunch", null)).toEqual([{ kind: "subcategory", category: "Dining", subcategory: "Brunch", newCategory: false }]);
    expect(createSuggestions(t, "Gifts > Birthdays", null)).toEqual([{ kind: "subcategory", category: "Gifts", subcategory: "Birthdays", newCategory: true }]);
    expect(createSuggestions(t, " / ", null)).toEqual([]);
  });
});
