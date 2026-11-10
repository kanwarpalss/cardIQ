// The daily job's balance step: read each program's newest balance-bearing
// email and save the balance under Miles & status (loyalty_accounts) when
// it is newer than what's saved. Runs inside scripts/find-deals.ts, sharing
// its IMAP connection; a failure here is reported, never fatal to deals.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImapSource } from "@/lib/gmail/mail-source";
import { stripHtml } from "@/lib/gmail/strip";
import { bestBodyText } from "@/lib/deals/extract";
import { matchProgram } from "@/lib/transfer-partners/math";
import { PROGRAMS } from "@/lib/transfer-partners/programs";
import { LOYALTY_READERS, planLoyaltyUpdate, type LoyaltyReading, type LoyaltyRowLite } from "./loyalty-emails";

/** How far back to look for a balance email (programs send monthly). */
const LOOKBACK_DAYS = 60;
/** Emails tried per program before giving up (Hilton promos lack the header now and then). */
const TRIES = 3;

/** Stored so the saved row sorts as "as of that day" in planLoyaltyUpdate. */
const stamp = (r: LoyaltyReading) => `${r.as_of}T23:59:59Z`;

export async function syncLoyaltyBalances(opts: {
  imap: ImapSource; sb: SupabaseClient; uid: string; apply: boolean; log: (...m: unknown[]) => void;
}): Promise<string> {
  const { imap, sb, uid, apply, log } = opts;
  const { data, error } = await sb.from("loyalty_accounts")
    .select("id, program_name, points_balance, updated_at").eq("user_id", uid);
  if (error) throw new Error(`loyalty_accounts: ${error.message}`);
  const rows: LoyaltyRowLite[] = (data ?? []).map((r) => ({
    id: r.id as string, program_key: matchProgram(r.program_name as string),
    points_balance: r.points_balance == null ? null : Number(r.points_balance), updated_at: r.updated_at as string,
  }));

  const done: string[] = [];
  for (const reader of LOYALTY_READERS) {
    const headers = (await imap.searchHeaders(`${reader.query} newer_than:${LOOKBACK_DAYS}d`))
      .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    let reading: LoyaltyReading | null = null;
    for (const h of headers.slice(0, TRIES)) {
      const m = await imap.fetchMessage(h.id);
      reading = reader.read(bestBodyText(m.textBody, m.htmlBody, stripHtml), h.date ?? new Date(m.internalDate).toISOString());
      if (reading) break;
    }
    const name = PROGRAMS[reader.program].name;
    if (!reading) { log(`  balance: ${name} — no readable balance email in ${LOOKBACK_DAYS} days`); continue; }

    const plan = planLoyaltyUpdate(reading, rows);
    log(`  balance: ${name} ${reading.balance.toLocaleString("en-IN")} as of ${reading.as_of} → ${plan.action}${plan.action === "keep" ? ` (${plan.reason})` : ""}`);
    if (plan.action === "keep") continue;
    if (apply) {
      const fields = {
        points_balance: reading.balance, source: "parsed", updated_at: stamp(reading),
        ...(reading.tier ? { tier: reading.tier } : {}),
      };
      const res = plan.action === "insert"
        ? await sb.from("loyalty_accounts").insert({
          ...fields, user_id: uid, program_name: name,
          program_type: PROGRAMS[reader.program].kind === "hotel" ? "hotel" : "airline",
        })
        : await sb.from("loyalty_accounts").update(fields).eq("id", plan.id);
      if (res.error) throw new Error(`loyalty_accounts ${plan.action}: ${res.error.message}`);
    }
    done.push(`${name} ${reading.balance.toLocaleString("en-IN")}`);
  }
  return done.length ? `Balances updated: ${done.join(", ")}` : "Balances: nothing newer";
}
