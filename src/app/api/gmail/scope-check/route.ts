import { google } from "googleapis";
import { ImapFlow } from "imapflow";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/crypto";

/**
 * Truthful Gmail-access self-check: makes the SAME kind of live call the sync
 * routes depend on, rather than just inspecting a cached credential — so
 * "connected" here means sync will actually work right now.
 *
 * Checks whichever MailSource the account is actually using (mirrors
 * pickMailSource's priority in src/lib/gmail/mail-source.ts): an IMAP app
 * password wins when present — it's the whole reason this migration
 * happened, since app passwords don't expire and OAuth refresh tokens die
 * every 7 days in Google's "Testing" publishing status. Falls back to the
 * OAuth check for any account still on the old path.
 *
 * OAuth failure modes distinguished (unchanged from before the IMAP work):
 *   - insufficient_scope: the token is valid but was never granted
 *     gmail.readonly. Re-clicking "sign in" alone often does NOT fix this.
 *   - expired_token: the refresh token itself was revoked/expired
 *     (invalid_grant) — common for Google apps still in "Testing" mode.
 */
export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: settings } = await supabase
    .from("user_settings")
    .select("google_refresh_token_encrypted, gmail_user, gmail_app_password_encrypted")
    .eq("user_id", user.id)
    .single();

  if (settings?.gmail_user && settings?.gmail_app_password_encrypted) {
    return checkImap(settings.gmail_user, decrypt(settings.gmail_app_password_encrypted));
  }

  if (!settings?.google_refresh_token_encrypted) {
    return NextResponse.json({
      status: "no_token",
      message: "No Gmail connection on file yet. Add a Gmail app password in Cards → Settings (recommended — never expires), or sign in with Google.",
    });
  }

  return checkOAuth(settings.google_refresh_token_encrypted);
}

async function checkImap(user: string, pass: string) {
  const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user, pass }, logger: false });
  try {
    await client.connect();
    await client.noop();
    return NextResponse.json({
      status: "ok",
      email: user,
      message: `Connected as ${user} via IMAP — Gmail sync will work.`,
    });
  } catch (e) {
    const raw = (e as Error).message || String(e);
    return NextResponse.json({
      status: "error",
      message: "Gmail couldn't be reached with the saved app password.",
      fix: "Check that it's still valid at myaccount.google.com/apppasswords, and that IMAP is turned on under Gmail → Settings → Forwarding and POP/IMAP — then re-save it in Cards → Settings. " + raw,
    });
  } finally {
    try { await client.logout(); } catch { /* connection may never have opened */ }
  }
}

async function checkOAuth(refreshTokenEncrypted: string) {
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: decrypt(refreshTokenEncrypted) });
  const gmail = google.gmail({ version: "v1", auth });

  try {
    const profile = await gmail.users.getProfile({ userId: "me" });
    return NextResponse.json({
      status: "ok",
      email: profile.data.emailAddress,
      message: `Connected as ${profile.data.emailAddress} — Gmail sync will work. (Still on OAuth — add a Gmail app password in Settings so this stops expiring every 7 days.)`,
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
        fix: "Simply signing in again usually does NOT fix this, because Google reuses the existing grant. Go to myaccount.google.com/permissions, remove CardIQ's access there, then come back and sign in again — that forces Google to ask for permission fresh. Or skip OAuth entirely by adding a Gmail app password in Settings.",
      });
    }
    if (isExpired) {
      return NextResponse.json({
        status: "expired_token",
        message: "Gmail access has expired or was revoked.",
        fix: "Add a Gmail app password in Cards → Settings instead — it never expires, unlike this OAuth connection. Or sign out and sign in again to reconnect via OAuth.",
      });
    }
    return NextResponse.json({
      status: "error",
      message: text,
      fix: "Unexpected error — try again, or check the browser console for details.",
    });
  }
}
