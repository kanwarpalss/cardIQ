import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/dining/review?limit=20
 * Returns pending dedupe review pairs from dining_dedupe_queue.
 *
 * POST /api/dining/review
 * Body: { queueId, decision: "same" | "different" }
 * Marks the queue item resolved and writes to dining_manual_links.
 */

export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 100);

  const { data, error } = await supabase
    .from("dining_dedupe_queue")
    .select(`
      id, platform_a, external_id_a, name_a,
      platform_b, external_id_b, name_b,
      canonical_id, reason, created_at,
      dining_restaurants!canonical_id ( canonical_name, area )
    `)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { count } = await supabase
    .from("dining_dedupe_queue")
    .select("*", { count: "exact", head: true })
    .eq("status", "pending");

  return NextResponse.json({ pairs: data ?? [], total: count ?? 0 });
}

export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json() as {
    queueId: string;
    decision: "same" | "different";
  };

  if (!body.queueId || !["same", "different"].includes(body.decision)) {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  // Load the queue row.
  const { data: row, error: fetchErr } = await supabase
    .from("dining_dedupe_queue")
    .select("platform_a, external_id_a, platform_b, external_id_b")
    .eq("id", body.queueId)
    .single();
  if (fetchErr || !row) return NextResponse.json({ error: "queue item not found" }, { status: 404 });

  // Write to dining_manual_links.
  const { error: linkErr } = await supabase
    .from("dining_manual_links")
    .upsert(
      {
        user_id: user.id,
        platform_a: row.platform_a,
        external_id_a: row.external_id_a,
        platform_b: row.platform_b,
        external_id_b: row.external_id_b,
        decision: body.decision,
      },
      { onConflict: "user_id,platform_a,external_id_a,platform_b,external_id_b" },
    );
  if (linkErr) return NextResponse.json({ error: linkErr.message }, { status: 500 });

  // Mark queue item resolved.
  await supabase
    .from("dining_dedupe_queue")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("id", body.queueId);

  return NextResponse.json({ ok: true });
}
