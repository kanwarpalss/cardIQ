import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/transactions/bulk-notes
 *
 * Sets the same note on ALL of the user's transactions with a given merchant
 * (V2 feature B: "apply to all N from merchant" on note edits).
 *
 * Body: { merchant: string, notes: string }   ("" clears the note everywhere)
 *
 * Notes are per-transaction data, not merchant metadata — so unlike category
 * edits this does NOT create a merchant_mapping; future syncs of this
 * merchant arrive note-less, as they should.
 */
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { merchant, notes } = body ?? {};

  if (!merchant || typeof merchant !== "string") {
    return NextResponse.json({ error: "merchant is required" }, { status: 400 });
  }
  if (typeof notes !== "string") {
    return NextResponse.json({ error: "notes must be a string ('' clears)" }, { status: 400 });
  }

  const { data: updated, error } = await supabase
    .from("transactions")
    .update({ notes })
    .eq("user_id", user.id)
    .eq("merchant", merchant)
    .select("id");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ updated: updated?.length ?? 0 });
}
