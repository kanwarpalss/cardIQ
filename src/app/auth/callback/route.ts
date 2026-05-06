import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { encrypt } from "@/lib/crypto";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  if (code) {
    const supabase = createClient();
    const { data } = await supabase.auth.exchangeCodeForSession(code);

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
  }

  return NextResponse.redirect(new URL("/", url.origin));
}
