import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/dining/sessions/status
 *
 * Returns the current state of the user's dining_sessions rows for
 * each of the three platforms. Powers the re-auth banner in DiningTab.
 *
 * Shape:
 *   {
 *     sessions: [
 *       { platform: "zomato",    state: "active" | "expired" | "missing",
 *         expires_at: "...", last_validated_at: "..." },
 *       ...
 *     ]
 *   }
 *
 * "expired" is best-effort (we compare against expires_at which is a
 * heuristic from cookie expiry). A session may also be invalid in
 * practice even if expires_at says active — only the next scrape run
 * will know for sure.
 */
export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const PLATFORMS = ["zomato", "swiggy", "eazydiner"] as const;
  type Platform = (typeof PLATFORMS)[number];

  const { data, error } = await supabase
    .from("dining_sessions")
    .select("platform, expires_at, last_validated_at")
    .eq("user_id", user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const byPlatform = new Map<string, { expires_at: string | null; last_validated_at: string | null }>();
  for (const row of data ?? []) {
    byPlatform.set(row.platform, {
      expires_at: row.expires_at,
      last_validated_at: row.last_validated_at,
    });
  }

  const now = Date.now();
  const sessions = PLATFORMS.map((p: Platform) => {
    const row = byPlatform.get(p);
    if (!row) {
      return { platform: p, state: "missing" as const, expires_at: null, last_validated_at: null };
    }
    const expMs = row.expires_at ? Date.parse(row.expires_at) : NaN;
    const state = isFinite(expMs) && expMs <= now ? ("expired" as const) : ("active" as const);
    return { platform: p, state, expires_at: row.expires_at, last_validated_at: row.last_validated_at };
  });

  return NextResponse.json({ sessions });
}
