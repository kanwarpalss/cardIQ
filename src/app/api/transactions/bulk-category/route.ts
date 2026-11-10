import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { normalizeName } from "@/lib/category-taxonomy";
import { upsertMerchantMapping } from "@/lib/merchant-mapping-store";
import { withOptionalColumns } from "@/lib/supabase/optional-columns";

/**
 * POST /api/transactions/bulk-category
 *
 * The same-merchant review popup: set one category on exactly the
 * transactions the user ticked — nothing else from that merchant changes.
 *
 * Body: {
 *   ids: string[]                 // the ticked transactions (max 5000)
 *   category: string
 *   subcategory?: string | null
 *   remember_merchant?: string    // also save a rule for FUTURE transactions
 * }
 *
 * Rows are marked `category_manual` (migration 025) so "Re-categorize" keeps
 * the user's choice, including on the rows they left unticked.
 */
const MAX_IDS = 5000;
const CHUNK = 200;

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const rawIds: unknown = body?.ids;
  if (!Array.isArray(rawIds) || rawIds.some((id) => typeof id !== "string" || !id)) {
    return NextResponse.json({ error: "ids must be a list of transaction ids" }, { status: 400 });
  }
  const ids = Array.from(new Set(rawIds as string[]));
  if (ids.length > MAX_IDS) {
    return NextResponse.json({ error: `At most ${MAX_IDS} transactions at once` }, { status: 400 });
  }
  const category = normalizeName(body?.category);
  if (!category) return NextResponse.json({ error: "category is required" }, { status: 400 });
  const subcategory = normalizeName(body?.subcategory) ?? null;
  const rememberMerchant = typeof body?.remember_merchant === "string" && body.remember_merchant.trim()
    ? body.remember_merchant.trim()
    : null;
  if (!ids.length && !rememberMerchant) {
    return NextResponse.json({ error: "Nothing selected" }, { status: 400 });
  }

  let updated = 0;
  let manualSaved = true;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { result, dropped } = await withOptionalColumns(
      { category, subcategory, category_manual: true },
      ["category_manual", "subcategory"],
      (values) => supabase
        .from("transactions")
        .update(values)
        .eq("user_id", user.id)
        .in("id", chunk)
        .select("id"),
    );
    if (dropped.includes("category_manual")) manualSaved = false;
    if (result.error) {
      return NextResponse.json(
        { error: `Updated ${updated} of ${ids.length} before an error: ${result.error.message}`, updated },
        { status: 500 },
      );
    }
    updated += result.data?.length ?? 0;
  }

  let remembered = false;
  if (rememberMerchant) {
    const err = await upsertMerchantMapping(supabase, user.id, {
      raw_name: rememberMerchant, normalized_name: rememberMerchant, category, subcategory,
    });
    if (err) {
      return NextResponse.json(
        { error: `Updated ${updated} transactions, but couldn't save the rule for future ones: ${err}`, updated },
        { status: 500 },
      );
    }
    remembered = true;
  }

  // `updated` < ids.length means some ids weren't the user's (or no longer exist).
  return NextResponse.json({ updated, requested: ids.length, remembered, manual_saved: manualSaved });
}
