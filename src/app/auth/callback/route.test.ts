import { describe, expect, it } from "vitest";
import { GET } from "./route";

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
    const request = new Request("http://localhost:3901/auth/callback", {
      headers: { host: "mac-mini.tail8f99cb.ts.net:3901" },
    });

    const response = await GET(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://mac-mini.tail8f99cb.ts.net:3901/login?error=auth_missing_code"
    );
  });

  it("prefers x-forwarded-host over a plain Host header", async () => {
    const request = new Request("http://localhost:3901/auth/callback", {
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
