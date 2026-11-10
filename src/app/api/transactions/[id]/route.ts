import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { withOptionalColumns } from "@/lib/supabase/optional-columns";

/**
 * PATCH /api/transactions/:id
 *
 * Updates a single transaction's category, subcategory and/or notes.
 * Body: { category?: string, subcategory?: string | null, notes?: string }
 *   (at least one required)
 *   - category:    any non-empty string (custom categories allowed; persisted as-is)
 *   - subcategory: second tier; pass "" or null to clear it
 *   - notes:       free-form text; pass "" to clear an existing note
 *
 * A category/subcategory edit also marks the row `category_manual`
 * (migration 025) so "Re-categorize" never overwrites the user's choice.
 */
export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  const params = await props.params;
  const supabase = await createClient();
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
  if ("category" in updates || "subcategory" in updates) updates.category_manual = true;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "category, subcategory or notes required" }, { status: 400 });
  }

  // Migrations 012 (subcategory) / 025 (category_manual) not yet run: save
  // what we can rather than failing the whole edit.
  const { result, dropped } = await withOptionalColumns(
    updates,
    ["category_manual", "subcategory"],
    (values): PromiseLike<{ error: { code?: string; message?: string } | null }> => Object.keys(values).length === 0
      ? Promise.resolve({ error: null })
      : supabase.from("transactions").update(values).eq("id", id).eq("user_id", user.id),
  );

  if (dropped.includes("subcategory") && Object.keys(updates).every((k) => k === "subcategory" || k === "category_manual")) {
    return NextResponse.json(
      { error: "Run supabase/migrations/012_subcategories.sql to enable subcategory saves." },
      { status: 400 }
    );
  }
  if (result.error) {
    return NextResponse.json({ error: result.error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
