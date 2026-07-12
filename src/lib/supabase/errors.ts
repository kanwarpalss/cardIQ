// PostgREST/Postgres error shapes that mean "the table doesn't exist yet" —
// i.e. a migration hasn't been run in the Supabase SQL Editor. UI uses this
// to show a run-the-migration notice instead of a crash.
//   42P01    = Postgres undefined_table
//   PGRST205 = PostgREST "table not found in schema cache"
export function isMissingTableError(
  error: { code?: string; message?: string } | null | undefined
): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /relation .* does not exist|could not find the table|schema cache/i.test(
    error.message ?? ""
  );
}

// "The column doesn't exist yet" — a column-adding migration (e.g. 012's
// subcategory) hasn't been run. Callers degrade to the old column set so
// core flows (especially Gmail sync) keep working pre-migration.
//   42703    = Postgres undefined_column
//   PGRST204 = PostgREST "column not found in schema cache"
export function isMissingColumnError(
  error: { code?: string; message?: string } | null | undefined,
  column: string
): boolean {
  if (!error) return false;
  const mentionsColumn = (error.message ?? "").includes(column);
  if (error.code === "42703" || error.code === "PGRST204") return mentionsColumn;
  return mentionsColumn && /column .* does not exist|could not find the .* column|schema cache/i.test(error.message ?? "");
}
