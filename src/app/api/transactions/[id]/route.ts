import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * PATCH /api/transactions/:id
 *
 * Updates a single transaction's category and/or notes.
 * Body: { category?: string, notes?: string }   (at least one required)
 *   - category: any non-empty string (custom categories allowed; persisted as-is)
 *   - notes:    free-form text; pass "" to clear an existing note
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
  const { category, notes } = body ?? {};

  const updates: Record<string, unknown> = {};
  if (typeof category === "string" && category.trim()) updates.category = category.trim();
  if (typeof notes === "string") updates.notes = notes; // "" clears the note

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "category or notes required" }, { status: 400 });
  }

  const { error } = await supabase
    .from("transactions")
    .update(updates)
    .eq("id", id)
    .eq("user_id", user.id); // RLS double-check: user can only edit own rows

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
