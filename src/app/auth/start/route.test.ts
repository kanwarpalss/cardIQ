import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const PROJECT_REF = "abcdefghijklmnopqrst";
const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token-code-verifier`;
const CARDIQ_ORIGIN = "http://mac-mini.tail8f99cb.ts.net:3901";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `https://${PROJECT_REF}.supabase.co`);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");
});

afterEach(() => vi.unstubAllEnvs());

describe("Google OAuth start", () => {
  it("sets the PKCE verifier on the redirect to Supabase", async () => {
    const response = await GET(new NextRequest("http://localhost:3901/auth/start", {
      headers: { host: "mac-mini.tail8f99cb.ts.net:3901" },
    }));

    expect(response.status).toBe(307);
    const destination = new URL(response.headers.get("location")!);
    expect(destination.origin).toBe(`https://${PROJECT_REF}.supabase.co`);
    expect(destination.pathname).toBe("/auth/v1/authorize");
    expect(destination.searchParams.get("provider")).toBe("google");
    expect(destination.searchParams.get("redirect_to")).toBe(
      `${CARDIQ_ORIGIN}/auth/callback`
    );
    expect(destination.searchParams.get("scopes")).toContain("gmail.readonly");
    expect(destination.searchParams.get("code_challenge")).toBeTruthy();

    const verifierCookie = response.headers.getSetCookie().find((value) =>
      value.startsWith(`${COOKIE_NAME}=`)
    );
    expect(verifierCookie).toBeDefined();
    expect(verifierCookie).toContain("Path=/");
    expect(verifierCookie).toMatch(/SameSite=lax/i);
    expect(verifierCookie).not.toContain("Max-Age=0");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("canonicalizes a short Mac mini host before generating OAuth state", async () => {
    const response = await GET(new NextRequest("http://localhost:3901/auth/start", {
      headers: { host: "mac-mini:3901" },
    }));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${CARDIQ_ORIGIN}/auth/start`);
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });

  it("replaces a stale verifier with fresh state", async () => {
    const response = await GET(new NextRequest("http://localhost:3901/auth/start", {
      headers: {
        host: "mac-mini.tail8f99cb.ts.net:3901",
        cookie: `${COOKIE_NAME}=stale`,
      },
    }));

    const verifierCookie = response.headers.getSetCookie().find((value) =>
      value.startsWith(`${COOKIE_NAME}=`)
    );
    expect(verifierCookie).toBeDefined();
    expect(verifierCookie).not.toContain("=stale");
  });
});
