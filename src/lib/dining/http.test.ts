// Tests for lib/dining/http.ts.
//
// We don't hit the real network — we inject a fake `fetch` and assert
// that the classifier + backoff loop do the right things for each
// response shape.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  diningFetch,
  diningFetchWithBackoff,
  parseRetryAfter,
  looksLikeCaptcha,
  safeHost,
} from "./http";

function makeResponse(status: number, body = "{}", headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

const FAST_POLICY = { minDelayMs: 0, maxDelayMs: 0, maxRetries: 2 };

// ────────────────────────────────────────────────────────────────────
describe("safeHost", () => {
  it("extracts host from a valid URL", () => {
    expect(safeHost("https://www.zomato.com/bangalore")).toBe("www.zomato.com");
  });
  it("returns null for garbage", () => {
    expect(safeHost("not a url")).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
describe("parseRetryAfter", () => {
  it("parses integer seconds → ms", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
  });
  it("parses HTTP-date → ms from now (positive)", () => {
    const future = new Date(Date.now() + 5_000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(3_000);
    expect(ms).toBeLessThan(7_000);
  });
  it("returns default on garbage", () => {
    expect(parseRetryAfter("nonsense")).toBe(2_000);
  });
});

// ────────────────────────────────────────────────────────────────────
describe("looksLikeCaptcha", () => {
  it("flags Cloudflare challenge HTML", () => {
    const body = "x".repeat(500) + " <title>Just a moment...</title> cloudflare ray id: abc123";
    expect(looksLikeCaptcha(body)).toBe(true);
  });
  it("flags PerimeterX page", () => {
    const body = "x".repeat(500) + " px-captcha challenge page";
    expect(looksLikeCaptcha(body)).toBe(true);
  });
  it("does NOT flag a normal JSON body", () => {
    expect(looksLikeCaptcha('{"restaurants":[{"name":"Toit"}]}')).toBe(false);
  });
  it("does NOT flag tiny bodies (no room for a challenge)", () => {
    expect(looksLikeCaptcha("captcha cloudflare")).toBe(false);
  });
  it("handles empty / null safely", () => {
    expect(looksLikeCaptcha("")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
describe("diningFetch classification", () => {
  beforeEach(() => vi.useRealTimers());

  it("returns ok on 200 with normal body", async () => {
    const fake = vi.fn().mockResolvedValue(makeResponse(200, '{"x":1}'));
    const out = await diningFetch("https://example.com/", {}, FAST_POLICY, fake as unknown as typeof fetch);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.body).toBe('{"x":1}');
  });

  it("returns blocked:auth_required on 401", async () => {
    const fake = vi.fn().mockResolvedValue(makeResponse(401));
    const out = await diningFetch("https://example.com/", {}, FAST_POLICY, fake as unknown as typeof fetch);
    expect(out.kind).toBe("blocked");
    if (out.kind === "blocked") expect(out.reason).toBe("auth_required");
  });

  it("returns blocked:forbidden on 403 (hard abort signal)", async () => {
    const fake = vi.fn().mockResolvedValue(makeResponse(403));
    const out = await diningFetch("https://example.com/", {}, FAST_POLICY, fake as unknown as typeof fetch);
    expect(out.kind).toBe("blocked");
    if (out.kind === "blocked") expect(out.reason).toBe("forbidden");
  });

  it("returns rate_limited on 429 with retry-after", async () => {
    const fake = vi.fn().mockResolvedValue(makeResponse(429, "", { "retry-after": "5" }));
    const out = await diningFetch("https://example.com/", {}, FAST_POLICY, fake as unknown as typeof fetch);
    expect(out.kind).toBe("rate_limited");
    if (out.kind === "rate_limited") expect(out.retryAfterMs).toBe(5_000);
  });

  it("returns blocked:captcha when 200 body looks like a challenge page", async () => {
    const challenge = "x".repeat(500) + " cloudflare ray id: 12ab34cd";
    const fake = vi.fn().mockResolvedValue(makeResponse(200, challenge));
    const out = await diningFetch("https://example.com/", {}, FAST_POLICY, fake as unknown as typeof fetch);
    expect(out.kind).toBe("blocked");
    if (out.kind === "blocked") expect(out.reason).toBe("captcha");
  });

  it("returns http_error for other 4xx/5xx", async () => {
    const fake = vi.fn().mockResolvedValue(makeResponse(500, "internal error"));
    const out = await diningFetch("https://example.com/", {}, FAST_POLICY, fake as unknown as typeof fetch);
    expect(out.kind).toBe("http_error");
    if (out.kind === "http_error") expect(out.status).toBe(500);
  });

  it("returns network_error for invalid URL", async () => {
    const fake = vi.fn();
    const out = await diningFetch("not-a-url", {}, FAST_POLICY, fake as unknown as typeof fetch);
    expect(out.kind).toBe("network_error");
  });

  it("returns network_error when fetch throws", async () => {
    const fake = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    const out = await diningFetch("https://example.com/", {}, FAST_POLICY, fake as unknown as typeof fetch);
    expect(out.kind).toBe("network_error");
    if (out.kind === "network_error") expect(out.message).toContain("ENOTFOUND");
  });

  it("injects Cookie header when supplied", async () => {
    const fake = vi.fn().mockResolvedValue(makeResponse(200));
    await diningFetch(
      "https://example.com/",
      { cookieHeader: "sid=abc; csrf=xyz" },
      FAST_POLICY,
      fake as unknown as typeof fetch,
    );
    expect(fake).toHaveBeenCalledOnce();
    const callOpts = fake.mock.calls[0][1] as RequestInit;
    expect((callOpts.headers as Record<string, string>)["Cookie"]).toBe("sid=abc; csrf=xyz");
  });

  it("sets a realistic User-Agent", async () => {
    const fake = vi.fn().mockResolvedValue(makeResponse(200));
    await diningFetch("https://example.com/", {}, FAST_POLICY, fake as unknown as typeof fetch);
    const callOpts = fake.mock.calls[0][1] as RequestInit;
    const ua = (callOpts.headers as Record<string, string>)["User-Agent"];
    expect(ua).toMatch(/Mozilla\/5\.0/);
    expect(ua).toMatch(/Chrome/);
  });
});

// ────────────────────────────────────────────────────────────────────
describe("diningFetchWithBackoff", () => {
  it("retries on 429 then succeeds", async () => {
    const fake = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(429, "", { "retry-after": "0" }))
      .mockResolvedValueOnce(makeResponse(200, "ok"));
    const out = await diningFetchWithBackoff(
      "https://example.com/",
      {},
      FAST_POLICY,
      fake as unknown as typeof fetch,
    );
    expect(out.kind).toBe("ok");
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxRetries on persistent 429", async () => {
    const fake = vi.fn().mockResolvedValue(makeResponse(429, "", { "retry-after": "0" }));
    const out = await diningFetchWithBackoff(
      "https://example.com/",
      {},
      FAST_POLICY,
      fake as unknown as typeof fetch,
    );
    expect(out.kind).toBe("rate_limited");
    // 1 initial + maxRetries (2) = 3 attempts
    expect(fake).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on 403 (hard abort)", async () => {
    const fake = vi.fn().mockResolvedValue(makeResponse(403));
    const out = await diningFetchWithBackoff(
      "https://example.com/",
      {},
      FAST_POLICY,
      fake as unknown as typeof fetch,
    );
    expect(out.kind).toBe("blocked");
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on http_error", async () => {
    const fake = vi.fn().mockResolvedValue(makeResponse(500));
    const out = await diningFetchWithBackoff(
      "https://example.com/",
      {},
      FAST_POLICY,
      fake as unknown as typeof fetch,
    );
    expect(out.kind).toBe("http_error");
    expect(fake).toHaveBeenCalledTimes(1);
  });
});
