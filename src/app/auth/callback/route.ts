import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { encrypt } from "@/lib/crypto";
import { loginRedirectForAuthCallback } from "@/lib/auth-callback";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  if (code) {
    const supabase = createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    const destination = loginRedirectForAuthCallback({
      hasCode: true,
      exchangeError: error,
      hasSession: Boolean(data.session),
      hasUser: Boolean(data.user),
    });

    if (destination !== "/") {
      // Do not expose Supabase's raw OAuth error in the URL. It can contain
      // provider detail; the login page only needs a useful next action.
      console.error("Google OAuth callback did not create a session", error?.message);
      return NextResponse.redirect(new URL(destination, url.origin));
    }

    // Persist the Google refresh token so the Gmail sync route can use it later.
    // provider_refresh_token is only present on first consent; subsequent logins
    // may omit it — only overwrite if we actually received one.
    if (data.session?.provider_refresh_token && data.user) {
      const encrypted = encrypt(data.session.provider_refresh_token);
      await supabase.from("user_settings").upsert(
        { user_id: data.user.id, google_refresh_token_encrypted: encrypted },
        { onConflict: "user_id" }
      );
    }

    return NextResponse.redirect(new URL("/", url.origin));
  }

  return NextResponse.redirect(
    new URL(
      loginRedirectForAuthCallback({
        hasCode: false,
        hasSession: false,
        hasUser: false,
      }),
      url.origin
    )
  );
}
