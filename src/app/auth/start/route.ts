import { NextRequest, NextResponse } from "next/server";
import { canonicalCardiqUrl, hostnameFromAuthority, requestOrigin } from "@/lib/canonical-host";
import { createAuthFlowClient } from "@/lib/supabase/auth-flow";

export async function GET(request: NextRequest) {
  const hostname =
    hostnameFromAuthority(request.headers.get("x-forwarded-host")) ??
    hostnameFromAuthority(request.headers.get("host")) ??
    request.nextUrl.hostname;
  const canonical = canonicalCardiqUrl(request.nextUrl, hostname);
  if (canonical) {
    return NextResponse.redirect(canonical);
  }

  const origin = requestOrigin(request.headers, request.nextUrl);
  const { supabase, redirect } = createAuthFlowClient(request);
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${origin}/auth/callback`,
      scopes: "openid email profile https://www.googleapis.com/auth/gmail.readonly",
      queryParams: { access_type: "offline", prompt: "consent" },
    },
  });

  if (error || !data.url) {
    console.error("Google OAuth could not start", error?.message);
    return redirect(new URL("/login?error=auth_start", origin));
  }

  return redirect(data.url);
}
