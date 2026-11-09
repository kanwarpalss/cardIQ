import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { loadExcludedMessageIds as load } from "./excluded-messages";

const loadExcludedMessageIds = (c: unknown, userId: string) => load(c as SupabaseClient, userId);

type Result = { data: { gmail_message_id: string }[] | null; error: { code?: string; message?: string } | null };
const client = (pages: Result[]) => {
  const calls: [number, number][] = [];
  return {
    calls,
    from: () => ({ select: () => ({ eq: () => ({ range: (a: number, b: number) => { calls.push([a, b]); return Promise.resolve(pages[calls.length - 1]); } }) }) }),
  };
};
const ids = (n: number, start = 0) => Array.from({ length: n }, (_, i) => ({ gmail_message_id: `m${start + i}` }));

describe("loadExcludedMessageIds", () => {
  it("reads every page, including one that is exactly full", async () => {
    const c = client([{ data: ids(1000), error: null }, { data: ids(1, 1000), error: null }]);
    const out = await loadExcludedMessageIds(c, "u");
    expect(out.size).toBe(1001);
    expect(out.has("m1000")).toBe(true);
    expect(c.calls).toEqual([[0, 999], [1000, 1999]]);
  });

  it("returns nothing to skip before migration 023 exists", async () => {
    const out = await loadExcludedMessageIds(client([{ data: null, error: { code: "PGRST205", message: "Could not find the table" } }]), "u");
    expect(out.size).toBe(0);
  });

  it("stops the caller on any other failure, so deleted rows are never re-created silently", async () => {
    await expect(loadExcludedMessageIds(client([{ data: null, error: { code: "08006", message: "connection failure" } }]), "u")).rejects.toThrow(/connection failure/);
  });
});
