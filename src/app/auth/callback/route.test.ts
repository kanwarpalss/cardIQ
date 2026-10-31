import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as startGoogleSignIn } from "../start/route";
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("auth callback origin resolution", () => {
  // Regression for the exact bug KP hit 2026-09-03: this route built its
  // redirects from request.url's own origin, which under `next start` with
  // no reverse proxy in front of it reflects the server's bind host
  // (localhost) rather than whichever host the browser actually used to
  // sign in. Reproduced live by curling /auth/callback on the Mac mini and
  // observing a redirect to a dead localhost:3901 regardless of the Host
  // header. The no-code branch below exercises the same origin computation
  // without needing to mock a real Supabase code exchange.
  it("redirects to the browser's real host, not the server's bind host, when Google returns no code", async () => {
    const request = new NextRequest("http://localhost:3901/auth/callback", {
      headers: { host: "mac-mini.tail8f99cb.ts.net:3901" },
    });

    const response = await GET(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://mac-mini.tail8f99cb.ts.net:3901/login?error=auth_missing_code"
    );
  });

  it("prefers x-forwarded-host over a plain Host header", async () => {
    const request = new NextRequest("http://localhost:3901/auth/callback", {
      headers: {
        host: "internal-proxy:3000",
        "x-forwarded-host": "card-iq.vercel.app",
        "x-forwarded-proto": "https",
      },
    });

    const response = await GET(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://card-iq.vercel.app/login?error=auth_missing_code"
    );
  });
});

describe("Google OAuth cookie round-trip", () => {
  const origin = "http://mac-mini.tail8f99cb.ts.net:3901";
  const projectRef = "abcdefghijklmnopqrst";
  const verifierName = `sb-${projectRef}-auth-token-code-verifier`;
  const sessionName = `sb-${projectRef}-auth-token`;

  it("exchanges the code and sends the long-lived session cookie on the home redirect", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `https://${projectRef}.supabase.co`);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");

    const start = await startGoogleSignIn(new NextRequest(`${origin}/auth/start`));
    const verifier = start.headers.getSetCookie().find((value) =>
      value.startsWith(`${verifierName}=`)
    );
    expect(verifier).toBeDefined();

    const tokenRequest = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      expect(url).toBe(`https://${projectRef}.supabase.co/auth/v1/token?grant_type=pkce`);
      const body = JSON.parse(String(init?.body));
      expect(body.auth_code).toBe("one-time-google-code");
      expect(body.code_verifier).toBeTruthy();
      return new Response(JSON.stringify({
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        token_type: "bearer",
        expires_in: 3600,
        user: { id: "user-123", aud: "authenticated", role: "authenticated" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", tokenRequest);

    const callback = await GET(new NextRequest(
      `http://localhost:3901/auth/callback?code=one-time-google-code`,
      { headers: {
        host: "mac-mini.tail8f99cb.ts.net:3901",
        cookie: verifier!.split(";")[0],
      } }
    ));

    expect(tokenRequest).toHaveBeenCalledOnce();
    expect(callback.status).toBe(307);
    expect(callback.headers.get("location")).toBe(`${origin}/`);
    const sessionCookie = callback.headers.getSetCookie().find((value) =>
      value.startsWith(`${sessionName}=`)
    );
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain("Max-Age=34560000");
    expect(callback.headers.get("cache-control")).toBe("private, no-store");
  });

  it("does not exchange a code when the verifier cookie is absent", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `https://${projectRef}.supabase.co`);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");
    const tokenRequest = vi.fn();
    vi.stubGlobal("fetch", tokenRequest);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const callback = await GET(new NextRequest(
      "http://localhost:3901/auth/callback?code=one-time-google-code",
      { headers: { host: "mac-mini.tail8f99cb.ts.net:3901" } }
    ));

    expect(tokenRequest).not.toHaveBeenCalled();
    expect(callback.headers.get("location")).toBe(`${origin}/login?error=auth_callback`);
  });
});
