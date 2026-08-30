import { createBrowserClient } from "@supabase/ssr";
import { requireSupabaseUrl } from "./health";

export function createClient() {
  return createBrowserClient(
    requireSupabaseUrl(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
