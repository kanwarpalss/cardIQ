import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { categorizeFull } from "@/lib/categorize";
import { cleanMerchant } from "@/lib/merchant-clean";
import { tryAllParsers } from "@/lib/parsers/registry";
import { isMissingColumnError } from "@/lib/supabase/errors";

// Re-process all stored transactions:
//   1. Re-parse from raw_subject + raw_body (in case parser improved)
//   2. Apply user-defined merchant mappings
//   3. Apply latest cleanMerchant + categorize rules (category + subcategory)
//
// Does not re-fetch from Gmail — operates entirely on stored raw_body.

export async function POST() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Probe for migration 012 once; degrade to category-only if not applied.
  type MappingRow = { raw_name: string; normalized_name: string; category: string; subcategory?: string | null };
  let mappingsRaw: MappingRow[] = [];
  let hasSubcategory = true;
  {
    const res = await supabase
      .from("merchant_mappings")
      .select("raw_name, normalized_name, category, subcategory")
      .eq("user_id", user.id);
    if (res.error && isMissingColumnError(res.error, "subcategory")) {
      hasSubcategory = false;
      const legacy = await supabase
        .from("merchant_mappings")
        .select("raw_name, normalized_name, category")
        .eq("user_id", user.id);
      mappingsRaw = (legacy.data ?? []) as MappingRow[];
    } else {
      mappingsRaw = (res.data ?? []) as MappingRow[];
    }
  }

  const merchantMap = new Map(
    mappingsRaw.map((m) => [m.raw_name.toLowerCase(), m])
  );

  const PAGE = 500;
  let from = 0;
  let updated = 0;
  let total = 0;

  while (true) {
    const { data: txns, error } = await supabase
      .from("transactions")
      .select(hasSubcategory
        ? "id, raw_subject, raw_body, merchant, category, subcategory"
        : "id, raw_subject, raw_body, merchant, category")
      .eq("user_id", user.id)
      .range(from, from + PAGE - 1);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!txns || txns.length === 0) break;
    total += txns.length;

    // Dynamic column set (with/without subcategory) defeats supabase-js's
    // literal-string type parser — cast through unknown to the real row shape.
    for (const t of txns as unknown as Array<{ id: string; raw_subject: string | null; raw_body: string | null; merchant: string | null; category: string | null; subcategory?: string | null }>) {
      const reparsed = tryAllParsers(t.raw_subject || "", t.raw_body || "", "");
      const rawMerchant = reparsed?.merchant_raw ?? null;

      const mapping = rawMerchant ? merchantMap.get(rawMerchant.toLowerCase()) : undefined;
      const cleaned = cleanMerchant(rawMerchant);
      const newMerchant = mapping?.normalized_name ?? cleaned ?? t.merchant;
      const ruled = categorizeFull(newMerchant);
      const newCategory = mapping?.category ?? ruled.category;
      const newSubcategory = mapping ? (mapping.subcategory ?? null) : ruled.subcategory;

      const subChanged = hasSubcategory && newSubcategory !== (t.subcategory ?? null);
      if (newMerchant !== t.merchant || newCategory !== t.category || subChanged) {
        await supabase
          .from("transactions")
          .update({
            merchant: newMerchant,
            category: newCategory,
            ...(hasSubcategory ? { subcategory: newSubcategory } : {}),
          })
          .eq("id", t.id);
        updated++;
      }
    }

    if (txns.length < PAGE) break;
    from += PAGE;
  }

  return NextResponse.json({ total, updated });
}
