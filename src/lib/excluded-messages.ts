// Emails a card statement proved were never charged (migration 023). Every path
// that turns an email into a transaction treats these IDs as "not a transaction",
// so a deleted hold or receipt can't be re-created by reprocess, backfill or a wipe.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingTableError } from "./supabase/errors";

const PAGE = 1000;

export async function loadExcludedMessageIds(client: SupabaseClient, userId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client.from("excluded_messages").select("gmail_message_id").eq("user_id", userId).range(from, from + PAGE - 1);
    // Before migration 023 nothing can have been excluded, so there is nothing to skip.
    if (error && isMissingTableError(error)) return ids;
    // Any other failure must stop the caller: skipping the check would re-create deleted rows.
    if (error) throw new Error(`Could not read excluded emails: ${error.message}`);
    for (const r of data ?? []) ids.add(r.gmail_message_id);
    if (!data || data.length < PAGE) return ids;
  }
}
