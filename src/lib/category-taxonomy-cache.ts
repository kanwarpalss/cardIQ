"use client";

import { createCachedResource } from "./resource-cache";
import type { CategoryAliases, Taxonomy, TaxonomyOp } from "./category-taxonomy";

export type CategoriesPayload = {
  taxonomy: Taxonomy | null;
  aliases: CategoryAliases;
  table_missing?: boolean;
};

const categories = createCachedResource<CategoriesPayload>("/api/categories", "category-taxonomy");

export const useCategoryTaxonomy = categories.useResource;
export const refreshCategoryTaxonomy = categories.refresh;

export type OpResponse = { summary: string; moved: { transactions: number; rules: number } };

/** Send one add/rename/delete/reorder. Throws a plain-English Error on failure. */
export async function sendTaxonomyOp(op: TaxonomyOp): Promise<OpResponse> {
  const res = await fetch("/api/categories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(op),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Couldn't save (error ${res.status}).`);
  // Show the saved tree immediately (a background refresh already in flight
  // could otherwise land the pre-edit list), then reconcile with the server.
  categories.patch((prev) => ({ ...prev, taxonomy: json.taxonomy, aliases: json.aliases, table_missing: false }));
  void categories.refresh().then(() => categories.refresh()); // 2nd = guaranteed post-edit fetch
  return json as OpResponse;
}
