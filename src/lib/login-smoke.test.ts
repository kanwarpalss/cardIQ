import { afterEach, describe, expect, it, vi } from "vitest";
import { runLoginSmoke } from "./login-smoke";

const INPUT = {
  rawLoginUrl: "http://100.81.29.11:3901/login?smoke=1",
  canonicalLoginUrl:
    "http://mac-mini.tail8f99cb.ts.net:3901/login?smoke=1",
  oauthAuthorizeUrl:
    "https://abcdefghijklmnopqrst.supabase.co/auth/v1/authorize?provider=google",
  timeoutMs: 1_000,
};

function response(status: number, location?: string, body = ""): Response {
  return new Response(body, {
    status,
    headers: location ? { location } : undefined,
  });
}

function successfulFetch() {
  return vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response(307, INPUT.canonicalLoginUrl))
    .mockResolvedValueOnce(response(200, undefined, "<title>CardIQ</title>"))
    .mockResolvedValueOnce(
      response(302, "https://accounts.google.com/v3/signin/accountchooser")
    );
}

describe("runLoginSmoke", () => {
  afterEach(() => vi.useRealTimers());

  it("proves the complete raw-IP to Google handoff", async () => {
    const fetchImpl = successfulFetch();
    await expect(runLoginSmoke({ ...INPUT, fetchImpl })).resolves.toBeUndefined();

    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.redirect).toBe("manual");
    }
  });

  it.each([
    ["wrong host", "http://evil.example/login?smoke=1"],
    ["wrong path", "http://mac-mini.tail8f99cb.ts.net:3901/"],
    ["lost query", "http://mac-mini.tail8f99cb.ts.net:3901/login"],
    ["redirect loop", INPUT.rawLoginUrl],
  ])("rejects a raw-entry redirect with %s", async (_name, location) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(307, location));
    await expect(runLoginSmoke({ ...INPUT, fetchImpl })).rejects.toThrow(
      /redirected|instead/i
    );
  });

  it("rejects a redirect with no Location header", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response(307));
    await expect(runLoginSmoke({ ...INPUT, fetchImpl })).rejects.toThrow(
      /location/i
    );
  });

  it.each([
    [
      200,
      "<html><title>Sorry, you have been blocked</title>Cloudflare Ray ID: abc</html>",
    ],
    [
      403,
      "<html>Sorry, you have been blocked. Performance & security by Cloudflare</html>",
    ],
  ])("identifies Cloudflare block HTML even with HTTP %i", async (status, body) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(307, INPUT.canonicalLoginUrl))
      .mockResolvedValueOnce(response(200, undefined, "<title>CardIQ</title>"))
      .mockResolvedValueOnce(response(status, undefined, body));
    await expect(runLoginSmoke({ ...INPUT, fetchImpl })).rejects.toThrow(
      /cloudflare blocked/i
    );
  });

  it.each([
    "https://accounts.google.com.evil.test/signin",
    "http://accounts.google.com/signin",
    "https://evil.test/?next=https://accounts.google.com",
    "/v3/signin/accountchooser",
  ])("rejects a deceptive Google redirect: %s", async (location) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(307, INPUT.canonicalLoginUrl))
      .mockResolvedValueOnce(response(200, undefined, "<title>CardIQ</title>"))
      .mockResolvedValueOnce(response(302, location));
    await expect(runLoginSmoke({ ...INPUT, fetchImpl })).rejects.toThrow(
      /accounts\.google\.com|location/i
    );
  });

  it("times out a request that never settles", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        })
    );

    const assertion = expect(
      runLoginSmoke({ ...INPUT, fetchImpl })
    ).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(INPUT.timeoutMs + 1);
    await assertion;
  });
});
