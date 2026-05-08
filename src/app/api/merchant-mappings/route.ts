import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/merchant-mappings
 *
 * Saves a merchant display-name / category override and immediately applies it
 * to all existing transactions with the old merchant name.
 *
 * Body: { old_name: string, new_name: string, category: string }
 *
 * - Upserts into merchant_mappings so future syncs pick it up.
 * - Bulk-updates transactions so the change is instant in the UI.
 * - Works for rename-only, category-only, or both in one call.
 */
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { old_name, new_name, category } = body ?? {};

  if (!old_name || typeof old_name !== "string") {
    return NextResponse.json({ error: "old_name is required" }, { status: 400 });
  }
  if (!new_name || typeof new_name !== "string") {
    return NextResponse.json({ error: "new_name is required" }, { status: 400 });
  }
  if (!category || typeof category !== "string") {
    return NextResponse.json({ error: "category is required" }, { status: 400 });
  }

  // 1. Upsert the mapping so future syncs respect this override.
  //    raw_name is keyed to the current display name (post-clean). The sync
  //    uses a two-pass lookup (raw first, then cleaned) so this is reliable.
  const { error: mapErr } = await supabase
    .from("merchant_mappings")
    .upsert(
      {
        user_id: user.id,
        raw_name: old_name,
        normalized_name: new_name,
        category,
      },
      { onConflict: "user_id,raw_name" }
    );

  if (mapErr) {
    return NextResponse.json({ error: mapErr.message }, { status: 500 });
  }

  // 2. Bulk-update all transactions for this user that currently have the old name.
  const { data: updated, error: txnErr } = await supabase
    .from("transactions")
    .update({ merchant: new_name, category })
    .eq("user_id", user.id)
    .eq("merchant", old_name)
    .select("id");

  if (txnErr) {
    return NextResponse.json({ error: txnErr.message }, { status: 500 });
  }

  return NextResponse.json({ updated: updated?.length ?? 0 });
}
