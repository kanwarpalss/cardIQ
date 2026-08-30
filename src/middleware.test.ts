import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { middleware } from "./middleware";

describe("middleware canonical host guard", () => {
  it("redirects a raw Tailscale login request before Supabase OAuth can run", async () => {
    const request = new NextRequest(
      "http://localhost:3128/login?next=%2Forders",
      { headers: { host: "100.81.29.11:3128" } }
    );

    const response = await middleware(request);

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

    const response = await middleware(request);

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

    const response = await middleware(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://mac-mini.tail8f99cb.ts.net:3128/login"
    );
  });
});
