import { describe, expect, it } from "vitest";
import { loginRedirectForAuthCallback } from "./auth-callback";

describe("loginRedirectForAuthCallback", () => {
  it("returns home only after Supabase created both a session and user", () => {
    expect(
      loginRedirectForAuthCallback({
        hasCode: true,
        hasSession: true,
        hasUser: true,
      })
    ).toBe("/");
  });

  it.each([
    ["Google returned without a code", { hasCode: false }],
    ["the code exchange fails", { hasCode: true, exchangeError: new Error("bad code") }],
    ["the code exchange returns no session", { hasCode: true, hasSession: false, hasUser: true }],
    ["the code exchange returns no user", { hasCode: true, hasSession: true, hasUser: false }],
  ])("keeps the user on login when %s", (_case, input) => {
    expect(loginRedirectForAuthCallback(input)).toBe(
      input.hasCode ? "/login?error=auth_callback" : "/login?error=auth_missing_code"
    );
  });
});
