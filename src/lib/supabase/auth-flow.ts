import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";
import { requireSupabaseUrl } from "./health";

type CookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * Auth redirects must carry the cookies written during the request. In
 * particular, Google must receive the PKCE verifier on the redirect that
 * starts OAuth, and the browser must receive the session on the callback's
 * redirect home. Relying on an implicit Next.js cookie merge loses that
 * guarantee when the route returns its own NextResponse.redirect().
 */
export function createAuthFlowClient(request: NextRequest) {
  const pendingCookies = new Map<string, CookieToSet>();
  const supabase = createServerClient(
    requireSupabaseUrl(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          for (const cookie of cookiesToSet) {
            request.cookies.set(cookie.name, cookie.value);
            pendingCookies.set(cookie.name, cookie);
          }
        },
      },
    }
  );

  function redirect(destination: string | URL): NextResponse {
    const response = NextResponse.redirect(destination);
    response.headers.set("Cache-Control", "private, no-store");
    for (const { name, value, options } of pendingCookies.values()) {
      response.cookies.set(name, value, options);
    }
    return response;
  }

  return { supabase, redirect };
}
