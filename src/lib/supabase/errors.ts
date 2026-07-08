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
