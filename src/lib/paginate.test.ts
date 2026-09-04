import { describe, expect, it, vi } from "vitest";
import { fetchAllPaginated, type PageResult } from "./paginate";

function page<T>(data: T[], count: number | null = null): PageResult<T> {
  return { data, count, error: null };
}
function errPage<T>(message: string, code?: string): PageResult<T> {
  return { data: null, count: null, error: { message, code } };
}

describe("fetchAllPaginated", () => {
  it("returns an empty result when there are no rows", async () => {
    const fetchPage = vi.fn(async () => page<number>([], 0));
    const result = await fetchAllPaginated(fetchPage, 10);
    expect(result).toEqual({ rows: [], error: null });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("does not fetch a second page when the first page is not full", async () => {
    const fetchPage = vi.fn(async () => page([1, 2, 3], 3));
    const result = await fetchAllPaginated(fetchPage, 10);
    expect(result).toEqual({ rows: [1, 2, 3], error: null });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("fetches remaining pages in parallel using the first page's exact count", async () => {
    const calls: number[] = [];
    const fetchPage = vi.fn(async (from: number, pageSize: number) => {
      calls.push(from);
      const remaining = 25 - from;
      const size = Math.min(pageSize, Math.max(remaining, 0));
      const data = Array.from({ length: size }, (_, i) => from + i);
      return page(data, from === 0 ? 25 : null);
    });

    const result = await fetchAllPaginated(fetchPage, 10);

    expect(result.error).toBeNull();
    // Concatenated in the correct order regardless of resolution order.
    expect(result.rows).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(calls.sort((a, b) => a - b)).toEqual([0, 10, 20]);
  });

  it("preserves row order even when a later page resolves before an earlier one", async () => {
    const fetchPage = vi.fn(async (from: number, pageSize: number) => {
      const data = [from, from + 1];
      const count = from === 0 ? 30 : null;
      // Page starting at 20 resolves first; page starting at 10 resolves last.
      const delayMs = from === 20 ? 0 : from === 10 ? 20 : 5;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      void pageSize;
      return page(data, count);
    });

    const result = await fetchAllPaginated(
      async (from, pageSize) => {
        if (from === 0) return page([0, 1], 30);
        return fetchPage(from, pageSize);
      },
      10
    );

    expect(result.rows.slice(0, 2)).toEqual([0, 1]);
    expect(result.rows).toEqual([0, 1, 10, 11, 20, 21]);
  });

  it("stops and surfaces the error from the first page", async () => {
    const fetchPage = vi.fn(async () => errPage<number>("boom", "500"));
    const result = await fetchAllPaginated(fetchPage, 10);
    expect(result).toEqual({ rows: [], error: { message: "boom", code: "500" } });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("stops and surfaces the error from a parallel page, discarding partial rows", async () => {
    const fetchPage = vi.fn(async (from: number) => {
      if (from === 0) return page([1, 2, 3], 33);
      if (from === 20) return errPage<number>("page 2 failed");
      return page([from], null);
    });
    const result = await fetchAllPaginated(fetchPage, 10);
    expect(result.rows).toEqual([]);
    expect(result.error?.message).toBe("page 2 failed");
  });

  it("falls back to sequential fetching when count is unavailable", async () => {
    const fetchPage = vi.fn(async (from: number) => {
      if (from === 0) return page([1, 2, 3, 4, 5], null); // full page, no count
      if (from === 5) return page([6, 7], null); // partial page — last one
      throw new Error("should not fetch past the short page");
    });
    const result = await fetchAllPaginated(fetchPage, 5);
    expect(result.rows).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("does not walk further when count is unavailable but the first page is already short", async () => {
    const fetchPage = vi.fn(async () => page([1, 2], null));
    const result = await fetchAllPaginated(fetchPage, 10);
    expect(result.rows).toEqual([1, 2]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("handles a count that lands exactly on a page boundary", async () => {
    const fetchPage = vi.fn(async (from: number) => {
      if (from === 0) return page([1, 2, 3, 4, 5], 10);
      if (from === 5) return page([6, 7, 8, 9, 10], null);
      throw new Error("unexpected extra page for an exact boundary count");
    });
    const result = await fetchAllPaginated(fetchPage, 5);
    expect(result.rows).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
