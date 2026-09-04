export type PageResult<T> = {
  data: T[] | null;
  count: number | null;
  error: { code?: string; message?: string } | null;
};

/**
 * Fetch every row via `fetchPage(from, pageSize)`. The first page's exact
 * row count (when the caller's fetcher requests one) reveals how many more
 * pages are needed, so every remaining page is fetched in parallel instead
 * of one at a time — previously `/api/transactions/all` walked its three
 * paginated tables sequentially, which meant a 3000+ row account paid for
 * 4+ full round-trips back to back on every single page load (2026-09-04).
 *
 * Falls back to the old one-at-a-time walk if the first page didn't come
 * back with a count (e.g. the caller's fetcher omits `{ count: "exact" }`,
 * or the backend doesn't support it) — still correct, just not parallel.
 *
 * Stops and returns the error from the first page (or any parallel page)
 * that fails; never returns a partial row set silently.
 */
export async function fetchAllPaginated<T>(
  fetchPage: (from: number, pageSize: number) => Promise<PageResult<T>>,
  pageSize = 1000
): Promise<{ rows: T[]; error: { code?: string; message?: string } | null }> {
  const first = await fetchPage(0, pageSize);
  if (first.error) return { rows: [], error: first.error };

  const rows: T[] = [...(first.data ?? [])];
  const total = first.count;

  if (typeof total === "number") {
    if (total > pageSize) {
      const starts: number[] = [];
      for (let from = pageSize; from < total; from += pageSize) starts.push(from);
      const pages = await Promise.all(starts.map((from) => fetchPage(from, pageSize)));
      for (const page of pages) {
        if (page.error) return { rows: [], error: page.error };
        rows.push(...(page.data ?? []));
      }
    }
    return { rows, error: null };
  }

  // No count available — fall back to sequential walking.
  if ((first.data?.length ?? 0) < pageSize) return { rows, error: null };
  let from = pageSize;
  while (true) {
    const page = await fetchPage(from, pageSize);
    if (page.error) return { rows: [], error: page.error };
    if (!page.data?.length) break;
    rows.push(...page.data);
    if (page.data.length < pageSize) break;
    from += pageSize;
  }
  return { rows, error: null };
}
