/**
 * Server-side load/save for the user's category tree (migration 025).
 * Works with both the request-scoped client and the service-role client
 * scripts use. Before the migration is run everything degrades to defaults.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingTableError } from "./supabase/errors";
import {
  sanitizeAliases,
  sanitizeTaxonomy,
  type CategoryAliases,
  type RowMove,
  type Taxonomy,
} from "./category-taxonomy";

export const TAXONOMY_TABLE = "user_category_taxonomy";
export { TAXONOMY_MIGRATION } from "./category-taxonomy";

export type TaxonomyRow = {
  taxonomy: Taxonomy | null;
  aliases: CategoryAliases;
  tableMissing: boolean;
  error: string | null;
};

 
type Sb = SupabaseClient<any, any, any>;

export async function loadTaxonomyRow(sb: Sb, userId: string): Promise<TaxonomyRow> {
  const { data, error } = await sb
    .from(TAXONOMY_TABLE)
    .select("categories, aliases")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    return { taxonomy: null, aliases: {}, tableMissing: isMissingTableError(error), error: isMissingTableError(error) ? null : error.message };
  }
  return {
    taxonomy: sanitizeTaxonomy(data?.categories),
    aliases: sanitizeAliases(data?.aliases),
    tableMissing: false,
    error: null,
  };
}

/**
 * Aliases for the ingest paths. Never throws and never blocks a sync: a
 * missing table means "no renames yet"; any other failure is logged loudly
 * and the sync carries on with default names (DEBUG-01).
 */
export async function loadCategoryAliases(sb: Sb, userId: string): Promise<CategoryAliases> {
  const row = await loadTaxonomyRow(sb, userId);
  if (row.error) console.warn(`[categories] couldn't load category renames, using default names: ${row.error}`);
  return row.aliases;
}

export async function saveTaxonomyRow(
  sb: Sb,
  userId: string,
  values: { taxonomy?: Taxonomy | null; aliases: CategoryAliases },
): Promise<string | null> {
  const row: Record<string, unknown> = { user_id: userId, aliases: values.aliases, updated_at: new Date().toISOString() };
  if (values.taxonomy !== undefined) row.categories = values.taxonomy;
  const { error } = await sb.from(TAXONOMY_TABLE).upsert(row, { onConflict: "user_id" });
  return error ? error.message : null;
}

/**
 * Run one planned move against a table that has category + subcategory
 * columns (transactions, merchant_mappings). Returns rows changed.
 */
export async function executeRowMove(
  sb: Sb,
  table: "transactions" | "merchant_mappings",
  userId: string,
  move: RowMove,
): Promise<{ count: number; error: string | null }> {
  const update: Record<string, unknown> = { category: move.to.category };
  if (move.to.subcategory !== undefined) update.subcategory = move.to.subcategory;
  let q = sb.from(table).update(update).eq("user_id", userId).eq("category", move.from.category);
  if (move.from.subcategory === null) q = q.is("subcategory", null);
  else if (move.from.subcategory !== undefined) q = q.eq("subcategory", move.from.subcategory);
  const { data, error } = await q.select(table === "transactions" ? "id" : "raw_name");
  return { count: data?.length ?? 0, error: error ? error.message : null };
}
