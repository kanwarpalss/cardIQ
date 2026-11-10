import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchAllPaginated, type PageResult } from "@/lib/paginate";
import { isMissingColumnError } from "@/lib/supabase/errors";
import {
  applyTaxonomyOp,
  effectiveTaxonomy,
  parseTaxonomyOp,
} from "@/lib/category-taxonomy";
import {
  TAXONOMY_MIGRATION,
  executeRowMove,
  loadTaxonomyRow,
  saveTaxonomyRow,
} from "@/lib/category-taxonomy-store";

/**
 * GET  /api/categories → { taxonomy: Taxonomy | null, aliases, table_missing }
 *   `taxonomy` null = the user hasn't customised anything (use defaults).
 *   The client merges in values seen on transactions (effectiveTaxonomy).
 *
 * POST /api/categories  body: TaxonomyOp (see src/lib/category-taxonomy.ts)
 *   add / rename / merge / delete / reorder. Renames and deletes rewrite
 *   every matching transaction AND merchant rule first, then save the tree,
 *   so the database and the list always agree.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const row = await loadTaxonomyRow(supabase, user.id);
  if (row.error) return NextResponse.json({ error: row.error }, { status: 500 });
  return NextResponse.json({ taxonomy: row.taxonomy, aliases: row.aliases, table_missing: row.tableMissing });
}

type Pair = { category: string | null; subcategory?: string | null };

async function observedPairs(
  supabase: Awaited<ReturnType<typeof createClient>>,
  table: "transactions" | "merchant_mappings",
  userId: string,
): Promise<{ rows: Pair[]; error: string | null }> {
  let cols = "category, subcategory";
  const page = (from: number, size: number) =>
    supabase
      .from(table)
      .select(cols, from === 0 ? { count: "exact" } : undefined)
      .eq("user_id", userId)
      .range(from, from + size - 1) as unknown as Promise<PageResult<Pair>>;
  let res = await fetchAllPaginated(page);
  if (res.error && isMissingColumnError(res.error, "subcategory")) {
    cols = "category";
    res = await fetchAllPaginated(page);
  }
  return { rows: res.rows, error: res.error ? res.error.message ?? "query failed" : null };
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const op = parseTaxonomyOp(await req.json().catch(() => null));
  if (!op) return NextResponse.json({ error: "That change wasn't understood." }, { status: 400 });

  const row = await loadTaxonomyRow(supabase, user.id);
  if (row.tableMissing) {
    return NextResponse.json(
      { error: `Run supabase/migrations/${TAXONOMY_MIGRATION} in the Supabase SQL Editor to edit categories.`, table_missing: true },
      { status: 409 },
    );
  }
  if (row.error) return NextResponse.json({ error: row.error }, { status: 500 });

  // Base = what the user actually sees: saved tree + every value in use.
  const [txns, rules] = await Promise.all([
    observedPairs(supabase, "transactions", user.id),
    observedPairs(supabase, "merchant_mappings", user.id),
  ]);
  if (txns.error || rules.error) {
    return NextResponse.json({ error: txns.error ?? rules.error }, { status: 500 });
  }
  const base = effectiveTaxonomy(row.taxonomy, [...txns.rows, ...rules.rows]);

  const result = applyTaxonomyOp({ taxonomy: base, aliases: row.aliases }, op);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  // Rewrite rows BEFORE saving the tree: if a rewrite fails, the old name is
  // still in the tree and still on the rows, so nothing is ever orphaned.
  let movedTxns = 0;
  let movedRules = 0;
  for (const move of result.moves) {
    const t = await executeRowMove(supabase, "transactions", user.id, move);
    if (t.error) return NextResponse.json({ error: `Couldn't move transactions: ${t.error}` }, { status: 500 });
    movedTxns += t.count;
    const r = await executeRowMove(supabase, "merchant_mappings", user.id, move);
    if (r.error) return NextResponse.json({ error: `Moved ${movedTxns} transactions, but couldn't update merchant rules: ${r.error}` }, { status: 500 });
    movedRules += r.count;
  }

  const saveErr = await saveTaxonomyRow(supabase, user.id, result.state);
  if (saveErr) {
    return NextResponse.json({ error: `Moved ${movedTxns} transactions, but couldn't save the category list: ${saveErr}` }, { status: 500 });
  }

  return NextResponse.json({
    taxonomy: result.state.taxonomy,
    aliases: result.state.aliases,
    summary: result.summary,
    moved: { transactions: movedTxns, rules: movedRules },
  });
}
