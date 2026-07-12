import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isMissingColumnError } from "@/lib/supabase/errors";

/**
 * PATCH /api/transactions/:id
 *
 * Updates a single transaction's category, subcategory and/or notes.
 * Body: { category?: string, subcategory?: string | null, notes?: string }
 *   (at least one required)
 *   - category:    any non-empty string (custom categories allowed; persisted as-is)
 *   - subcategory: second tier; pass "" or null to clear it
 *   - notes:       free-form text; pass "" to clear an existing note
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = params;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const body = await req.json().catch(() => null);
  const { category, subcategory, notes } = body ?? {};

  const updates: Record<string, unknown> = {};
  if (typeof category === "string" && category.trim()) updates.category = category.trim();
  if (typeof subcategory === "string") updates.subcategory = subcategory.trim() || null; // "" clears
  if (subcategory === null) updates.subcategory = null;
  if (typeof notes === "string") updates.notes = notes; // "" clears the note

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "category, subcategory or notes required" }, { status: 400 });
  }

  let { error } = await supabase
    .from("transactions")
    .update(updates)
    .eq("id", id)
    .eq("user_id", user.id);

  // Migration 012 not yet run: retry without subcategory so category/notes
  // still save. Subcategory just won't persist until the migration is applied.
  if (error && isMissingColumnError(error, "subcategory")) {
    const { subcategory: _dropped, ...updatesNoSub } = updates;
    if (Object.keys(updatesNoSub).length === 0) {
      return NextResponse.json(
        { error: "Run supabase/migrations/012_subcategories.sql to enable subcategory saves." },
        { status: 400 }
      );
    }
    ({ error } = await supabase
      .from("transactions")
      .update(updatesNoSub)
      .eq("id", id)
      .eq("user_id", user.id));
  }

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
