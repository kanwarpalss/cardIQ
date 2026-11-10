import type { SupabaseClient } from "@supabase/supabase-js";
import { withOptionalColumns } from "./supabase/optional-columns";

 
type Sb = SupabaseClient<any, any, any>;

/**
 * Save "transactions from this merchant go to X" for future syncs. Keyed on
 * the display name, which the sync's two-pass lookup (raw, then cleaned)
 * finds reliably (invariant 5). Shared by the merchant editor and the
 * same-merchant review popup so both write exactly the same rule.
 */
export async function upsertMerchantMapping(
  sb: Sb,
  userId: string,
  rule: { raw_name: string; normalized_name: string; category: string; subcategory: string | null },
): Promise<string | null> {
  const { result } = await withOptionalColumns(
    { user_id: userId, ...rule },
    ["subcategory"], // migration 012 not yet run → save without it
    (values) => sb.from("merchant_mappings").upsert(values, { onConflict: "user_id,raw_name" }),
  );
  return result.error ? result.error.message : null;
}
