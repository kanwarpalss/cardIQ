import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

type CookieToSet = { name: string; value: string; options: CookieOptions };

/** Reject if a promise doesn't settle in time, so a hung Supabase call can't
 *  freeze navigation. Paused free-tier projects sometimes resolve DNS but
 *  never answer — without this the request blocks for the full fetch timeout. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms)
    ),
  ]);
}

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isPublic = path.startsWith("/login") || path.startsWith("/auth");

  // Public routes never need an auth round-trip. Skipping the Supabase call
  // here keeps /login instant even when the backend is paused/unreachable —
  // and /auth/callback handles its own session exchange.
  if (isPublic) {
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  let user = null;
  try {
    ({ data: { user } } = await withTimeout(supabase.auth.getUser(), 4000));
  } catch {
    // Supabase unreachable or hung (e.g. paused free-tier project). Don't 500
    // or hang — send the user to /login, which shows the connection notice.
    return NextResponse.redirect(new URL("/login?error=connection", request.url));
  }

  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
