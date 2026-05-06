import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { categorize } from "@/lib/categorize";
import { cleanMerchant } from "@/lib/merchant-clean";
import { tryAllParsers } from "@/lib/parsers/registry";

// Re-process all stored transactions:
//   1. Re-parse from raw_subject + raw_body (in case parser improved)
//   2. Apply user-defined merchant mappings
//   3. Apply latest cleanMerchant + categorize rules
//
// Does not re-fetch from Gmail — operates entirely on stored raw_body.

export async function POST() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: mappingsRaw } = await supabase
    .from("merchant_mappings")
    .select("raw_name, normalized_name, category")
    .eq("user_id", user.id);

  const merchantMap = new Map(
    (mappingsRaw || []).map((m) => [m.raw_name.toLowerCase(), m])
  );

  const PAGE = 500;
  let from = 0;
  let updated = 0;
  let total = 0;

  while (true) {
    const { data: txns, error } = await supabase
      .from("transactions")
      .select("id, raw_subject, raw_body, merchant, category")
      .eq("user_id", user.id)
      .range(from, from + PAGE - 1);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!txns || txns.length === 0) break;
    total += txns.length;

    for (const t of txns) {
      const reparsed = tryAllParsers(t.raw_subject || "", t.raw_body || "", "");
      const rawMerchant = reparsed?.merchant_raw ?? null;

      const mapping = rawMerchant ? merchantMap.get(rawMerchant.toLowerCase()) : undefined;
      const cleaned = cleanMerchant(rawMerchant);
      const newMerchant = mapping?.normalized_name ?? cleaned ?? t.merchant;
      const newCategory = mapping?.category ?? categorize(newMerchant);

      if (newMerchant !== t.merchant || newCategory !== t.category) {
        await supabase
          .from("transactions")
          .update({ merchant: newMerchant, category: newCategory })
          .eq("id", t.id);
        updated++;
      }
    }

    if (txns.length < PAGE) break;
    from += PAGE;
  }

  return NextResponse.json({ total, updated });
}
