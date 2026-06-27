import { describe, it, expect, afterEach } from "vitest";
import { getSupabaseUrl, getProjectRef, getDashboardUrl } from "./health";

const ORIGINAL = process.env.NEXT_PUBLIC_SUPABASE_URL;

afterEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGINAL;
});

describe("getSupabaseUrl", () => {
  it("strips a trailing slash", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcd1234.supabase.co/";
    expect(getSupabaseUrl()).toBe("https://abcd1234.supabase.co");
  });

  it("leaves a clean url untouched", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcd1234.supabase.co";
    expect(getSupabaseUrl()).toBe("https://abcd1234.supabase.co");
  });

  it("returns empty string when unset", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(getSupabaseUrl()).toBe("");
  });
});

describe("getProjectRef", () => {
  it("extracts the ref from the hostname (with trailing slash)", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dmmhtzwxqkduxvxipfqs.supabase.co/";
    expect(getProjectRef()).toBe("dmmhtzwxqkduxvxipfqs");
  });

  it("extracts the ref without a trailing slash", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcd1234.supabase.co";
    expect(getProjectRef()).toBe("abcd1234");
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
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcd1234.supabase.co";
    expect(getDashboardUrl()).toBe(
      "https://supabase.com/dashboard/project/abcd1234"
    );
  });

  it("falls back to the dashboard root when ref is unknown", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(getDashboardUrl()).toBe("https://supabase.com/dashboard");
  });
});
