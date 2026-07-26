/**
 * Remove unpaired rows from the Review queue without deleting their order
 * history. Read-only by default; --apply changes only pending orders with no
 * txn_id back to 'unmatched'.
 *
 * Run: npx tsx scripts/clean-review-queue.ts [--apply]
 */
import { readFileSync } from "fs";
import { join } from "path";

for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const match = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
}

import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

async function main() {
  const { data: candidates, error: readError } = await supabase
    .from("orders")
    .select("id, user_id")
    .eq("review_status", "pending")
    .is("txn_id", null);
  if (readError) throw readError;

  const byUser = new Map<string, string[]>();
  for (const row of candidates ?? []) {
    (byUser.get(row.user_id) ?? byUser.set(row.user_id, []).get(row.user_id)!).push(row.id);
  }
  console.log(`${APPLY ? "APPLY" : "DRY RUN"}: ${candidates?.length ?? 0} unpaired pending Review rows across ${byUser.size} user(s).`);
  if (!APPLY || !candidates?.length) return;

  for (const [userId, ids] of byUser) {
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await supabase
        .from("orders")
        .update({ review_status: "unmatched" })
        .eq("user_id", userId)
        .eq("review_status", "pending")
        .is("txn_id", null)
        .in("id", ids.slice(i, i + 100))
        .select("id");
      if (error) throw error;
      if (data?.length !== ids.slice(i, i + 100).length) {
        throw new Error(`Safety check failed: expected ${ids.slice(i, i + 100).length} updates, changed ${data?.length ?? 0}.`);
      }
    }
  }
  console.log(`Cleaned ${candidates.length} unpaired rows. No orders or transactions were deleted.`);
}

main().catch((error) => {
  console.error("Review queue cleanup failed:", error.message ?? error);
  process.exit(1);
});
