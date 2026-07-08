import { google } from "googleapis";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/crypto";

/**
 * Truthful Gmail-access self-check: makes the SAME kind of live API call the
 * sync route depends on (gmail.users.getProfile), rather than just inspecting
 * a cached token — so "connected" here means sync will actually work right now.
 *
 * Distinguishes the two failure modes that get conflated in the wild:
 *   - insufficient_scope: the token is valid but was never granted
 *     gmail.readonly. Re-clicking "sign in" alone often does NOT fix this —
 *     see the `fix` message for why.
 *   - expired_token: the refresh token itself was revoked/expired
 *     (invalid_grant) — common for Google apps still in "Testing" mode.
 */
export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: settings } = await supabase
    .from("user_settings")
    .select("google_refresh_token_encrypted")
    .eq("user_id", user.id)
    .single();

  if (!settings?.google_refresh_token_encrypted) {
    return NextResponse.json({
      status: "no_token",
      message: "No Gmail connection on file yet. Sign in with Google to connect.",
    });
  }

  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: decrypt(settings.google_refresh_token_encrypted) });
  const gmail = google.gmail({ version: "v1", auth });

  try {
    const profile = await gmail.users.getProfile({ userId: "me" });
    return NextResponse.json({
      status: "ok",
      email: profile.data.emailAddress,
      message: `Connected as ${profile.data.emailAddress} — Gmail sync will work.`,
    });
  } catch (e) {
    const raw = (e as { message?: string; code?: number; errors?: Array<{ reason?: string }> });
    const text = raw?.message || String(e);

    const isScopeIssue =
      raw?.code === 403 ||
      /insufficient.*(scope|permission)/i.test(text) ||
      raw?.errors?.some((er) => er.reason === "insufficientPermissions");

    const isExpired = /invalid_grant|invalid_token/i.test(text);

    if (isScopeIssue) {
      return NextResponse.json({
        status: "insufficient_scope",
        message: "Gmail access was granted WITHOUT read permission — sync will keep failing.",
        fix: "Simply signing in again usually does NOT fix this, because Google reuses the existing grant. Go to myaccount.google.com/permissions, remove CardIQ's access there, then come back and sign in again — that forces Google to ask for permission fresh.",
      });
    }
    if (isExpired) {
      return NextResponse.json({
        status: "expired_token",
        message: "Gmail access has expired or was revoked.",
        fix: "Sign out and sign in again to reconnect.",
      });
    }
    return NextResponse.json({
      status: "error",
      message: text,
      fix: "Unexpected error — try again, or check the browser console for details.",
    });
  }
}
