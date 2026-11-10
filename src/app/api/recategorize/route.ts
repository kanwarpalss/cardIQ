import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { categorizeFull } from "@/lib/categorize";
import { resolveTxnCategory } from "@/lib/category-taxonomy";
import { loadCategoryAliases } from "@/lib/category-taxonomy-store";
import { cleanMerchant } from "@/lib/merchant-clean";
import { tryAllParsers } from "@/lib/parsers/registry";
import { isMissingColumnError } from "@/lib/supabase/errors";

// Re-process all stored transactions:
//   1. Re-parse from raw_subject + raw_body (in case parser improved)
//   2. Apply user-defined merchant mappings
//   3. Apply latest cleanMerchant + categorize rules (category + subcategory),
//      then the user's category renames/deletes (migration 025)
//
// A transaction whose category the user picked by hand (category_manual,
// migration 025) keeps that category — only its merchant name is refreshed.
// That is what makes "leave these ones out" in the review popup stick.
//
// Does not re-fetch from Gmail — operates entirely on stored raw_body.

type Row = {
  id: string; raw_subject: string | null; raw_body: string | null; merchant: string | null;
  category: string | null; subcategory?: string | null; category_manual?: boolean | null;
};

export async function POST() {
  const supabase = await createClient();
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
  const categoryAliases = await loadCategoryAliases(supabase, user.id);

  const PAGE = 500;
  let from = 0;
  let updated = 0;
  let total = 0;
  let keptManual = 0;
  let hasManual = true;

  while (true) {
    const cols = ["id, raw_subject, raw_body, merchant, category", hasSubcategory ? "subcategory" : null, hasManual ? "category_manual" : null]
      .filter(Boolean).join(", ");
    const { data: txns, error } = await supabase
      .from("transactions")
      .select(cols)
      .eq("user_id", user.id)
      .order("id")
      .range(from, from + PAGE - 1);

    if (error && hasManual && isMissingColumnError(error, "category_manual")) {
      hasManual = false; // migration 025 not run: nothing is marked manual yet
      continue;
    }
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!txns || txns.length === 0) break;
    total += txns.length;

    // Dynamic column set defeats supabase-js's literal-string type parser —
    // cast through unknown to the real row shape.
    for (const t of txns as unknown as Row[]) {
      const reparsed = tryAllParsers(t.raw_subject || "", t.raw_body || "", "");
      const rawMerchant = reparsed?.merchant_raw ?? null;

      const mapping = rawMerchant ? merchantMap.get(rawMerchant.toLowerCase()) : undefined;
      const cleaned = cleanMerchant(rawMerchant);
      const newMerchant = mapping?.normalized_name ?? cleaned ?? t.merchant;

      const manual = t.category_manual === true;
      const resolved = manual
        ? { category: t.category, subcategory: t.subcategory ?? null }
        : resolveTxnCategory(mapping, categorizeFull(newMerchant), categoryAliases);
      if (manual) keptManual++;

      const subChanged = hasSubcategory && resolved.subcategory !== (t.subcategory ?? null);
      if (newMerchant !== t.merchant || resolved.category !== t.category || subChanged) {
        const { error: updErr } = await supabase
          .from("transactions")
          .update({
            merchant: newMerchant,
            category: resolved.category,
            ...(hasSubcategory ? { subcategory: resolved.subcategory } : {}),
          })
          .eq("id", t.id);
        if (updErr) return NextResponse.json({ error: `Stopped after ${updated} updates: ${updErr.message}` }, { status: 500 });
        updated++;
      }
    }

    if (txns.length < PAGE) break;
    from += PAGE;
  }

  return NextResponse.json({ total, updated, kept_manual: keptManual });
}
