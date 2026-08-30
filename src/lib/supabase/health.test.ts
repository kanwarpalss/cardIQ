import { describe, it, expect, afterEach } from "vitest";
import {
  getSupabaseUrl,
  getProjectRef,
  getDashboardUrl,
  requireSupabaseUrl,
} from "./health";

const ORIGINAL = process.env.NEXT_PUBLIC_SUPABASE_URL;

afterEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGINAL;
});

describe("getSupabaseUrl", () => {
  it("strips a trailing slash", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL =
      "https://abcdefghijklmnopqrst.supabase.co/";
    expect(getSupabaseUrl()).toBe(
      "https://abcdefghijklmnopqrst.supabase.co"
    );
  });

  it("leaves a clean url untouched", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL =
      "https://abcdefghijklmnopqrst.supabase.co";
    expect(getSupabaseUrl()).toBe(
      "https://abcdefghijklmnopqrst.supabase.co"
    );
  });

  it("returns empty string when unset", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(getSupabaseUrl()).toBe("");
  });

  it.each([
    "https://supabase.co",
    "http://abcdefghijklmnopqrst.supabase.co",
    "https://abcdefghijklmnopqrs.supabase.co",
    "https://abcdefghijklmnopqrstu.supabase.co",
    "https://abcdefghijklmnopqrst.supabase.co.evil.example",
    "https://abcdefghijklmnopqrst.supabase.co@evil.example",
    "https://user@abcdefghijklmnopqrst.supabase.co",
    "https://abcdefghijklmnopqrst.supabase.co:444",
    "https://abcdefghijklmnopqrst.supabase.co/auth/v1",
    "https://abcdefghijklmnopqrst.supabase.co?redirect=evil",
    "https://abcdefghijklmnopqrst.supabase.co#fragment",
    "not a url",
  ])("rejects an unsafe or malformed project URL: %s", (url) => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = url;
    expect(getSupabaseUrl()).toBe("");
  });

  it("makes invalid configuration fail loudly for API callers", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.co";
    expect(() => requireSupabaseUrl()).toThrow(
      "NEXT_PUBLIC_SUPABASE_URL must be an HTTPS Supabase project URL"
    );
  });
});

describe("getProjectRef", () => {
  it("extracts the ref from the hostname (with trailing slash)", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dmmhtzwxqkduxvxipfqs.supabase.co/";
    expect(getProjectRef()).toBe("dmmhtzwxqkduxvxipfqs");
  });

  it("extracts the ref without a trailing slash", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL =
      "https://abcdefghijklmnopqrst.supabase.co";
    expect(getProjectRef()).toBe("abcdefghijklmnopqrst");
  });

  it("returns empty string for a garbage url", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "not a url";
    expect(getProjectRef()).toBe("");
  });

  it("returns empty string when unset", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(getProjectRef()).toBe("");
  });
});

describe("getDashboardUrl", () => {
  it("links straight to the project when a ref is known", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL =
      "https://abcdefghijklmnopqrst.supabase.co";
    expect(getDashboardUrl()).toBe(
      "https://supabase.com/dashboard/project/abcdefghijklmnopqrst"
    );
  });

  it("falls back to the dashboard root when ref is unknown", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(getDashboardUrl()).toBe("https://supabase.com/dashboard");
  });
});
