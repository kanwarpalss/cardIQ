import { isMissingColumnError } from "./errors";

type DbError = { code?: string; message?: string } | null;

/**
 * Run a write, and if Postgres says one of the `optional` columns doesn't
 * exist yet (its migration hasn't been run), drop that column and retry.
 * Core edits keep working before a migration; the dropped columns are
 * returned so callers can say so instead of failing silently.
 */
export async function withOptionalColumns<T extends Record<string, unknown>, R extends { error: DbError }>(
  values: T,
  optional: readonly string[],
  run: (values: Partial<T>) => PromiseLike<R>,
): Promise<{ result: R; dropped: string[] }> {
  const current: Partial<T> = { ...values };
  const dropped: string[] = [];
  for (;;) {
    const result = await run(current);
    const missing = result.error
      ? optional.find((col) => col in current && isMissingColumnError(result.error, col))
      : undefined;
    if (!missing) return { result, dropped };
    delete current[missing as keyof T];
    dropped.push(missing);
  }
}
