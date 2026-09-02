import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isMissingTableError } from "@/lib/supabase/errors";
import { decideAutoSync, type SyncStatus } from "@/lib/gmail/auto-sync";

/**
 * Cheap read-only "should the app sync right now?" probe.
 *
 * Called on app open and on window refocus, so it must stay tiny: three
 * indexed lookups, no Gmail API call, no writes. The actual decision comes
 * from decideAutoSync() so the server and the client can never disagree about
 * what "stale" means (ARCH-04).
 *
 * Notably this does NOT verify the refresh token still works with Google —
 * that costs a network round-trip to Google on every page load. A dead token
 * surfaces when the sync itself runs, and the client escalates it to a
 * persistent reconnect banner.
 */

/** Cursor row written by /api/gmail/sync for the combined bank-sender query. */
const CURSOR_KEY = "_all";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [settingsRes, cursorRes] = await Promise.all([
    supabase
      .from("user_settings")
      .select("google_refresh_token_encrypted, gmail_user, gmail_app_password_encrypted, last_gmail_sync_at")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("gmail_sync_state")
      .select("last_internal_date, last_synced_at")
      .eq("user_id", user.id)
      .eq("sender", CURSOR_KEY)
      .maybeSingle(),
  ]);

  // A missing gmail_sync_state table (migration 004 not run) must not 500 the
  // page — it just means "no cursor", which the decision treats as first sync.
  if (cursorRes.error && !isMissingTableError(cursorRes.error)) {
    console.error("[gmail/sync-status] cursor read error:", cursorRes.error.message);
  }

  // Prefer the per-cursor timestamp; fall back to the legacy user_settings one.
  const lastSyncedAt =
    cursorRes.data?.last_synced_at ??
    settingsRes.data?.last_gmail_sync_at ??
    null;

  const status: SyncStatus = {
    hasRefreshToken: !!(
      settingsRes.data?.google_refresh_token_encrypted ||
      (settingsRes.data?.gmail_user && settingsRes.data?.gmail_app_password_encrypted)
    ),
    hasCursor: cursorRes.data?.last_internal_date != null,
    lastSyncedAt,
  };

  return NextResponse.json({
    ...status,
    decision: decideAutoSync(status),
  });
}
