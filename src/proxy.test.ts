import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { proxy } from "./proxy";

const ORIGINAL_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;

afterEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGINAL_SUPABASE_URL;
});

describe("proxy canonical host guard", () => {
  it("redirects a raw Tailscale login request before Supabase OAuth can run", async () => {
    const request = new NextRequest(
      "http://localhost:3128/login?next=%2Forders",
      { headers: { host: "100.81.29.11:3128" } }
    );

    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://mac-mini.tail8f99cb.ts.net:3128/login?next=%2Forders"
    );
  });

  it("keeps the canonical MagicDNS login route public and in place", async () => {
    const request = new NextRequest(
      "http://localhost:3128/login",
      { headers: { host: "mac-mini.tail8f99cb.ts.net:3128" } }
    );

    const response = await proxy(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("prefers the browser-facing forwarded host over an internal Host header", async () => {
    const request = new NextRequest("http://localhost:3128/login", {
      headers: {
        host: "internal-proxy:3000",
        "x-forwarded-host": "100.81.29.11:3128",
      },
    });

    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://mac-mini.tail8f99cb.ts.net:3128/login"
    );
  });

  it("canonicalizes the raw Tailscale IPv6 host too", async () => {
    const request = new NextRequest("http://localhost:3128/login", {
      headers: { host: "[fd7a:115c:a1e0::1]:3128" },
    });

    const response = await proxy(request);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://mac-mini.tail8f99cb.ts.net:3128/login"
    );
  });

  it("fails safely to the connection notice when Supabase URL is malformed", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.co";
    const request = new NextRequest("http://localhost:3128/orders", {
      headers: { host: "mac-mini.tail8f99cb.ts.net:3128" },
    });

    const response = await proxy(request);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3128/login?error=connection"
    );
  });
});
