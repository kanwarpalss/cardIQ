/**
 * statements-fill-fx.ts — give old foreign alerts their real rupee cost from statements.
 *
 * Some old foreign alerts have amount_inr = 0 because no exchange rate was found.
 * Citi statements show only the rupees billed, so statements-reconcile.ts couldn't
 * pair those lines and added them as new "stmt:" rows: the same purchase twice.
 * This pairs each zero-rupee alert with a statement row on the same card account,
 * within 3 days, naming the same merchant; copies the billed rupees onto the alert
 * (the bank's own conversion); and removes the duplicate statement row. An alert
 * with no single clear partner is left alone and listed.
 *
 * READ-ONLY by default. Run:  npx tsx scripts/statements-fill-fx.ts [--apply]
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { merchantsAgree, REISSUED_CARDS } from "../src/lib/statements/reconcile";

const APPLY = process.argv.includes("--apply");
const accountOf = (last4: string) => REISSUED_CARDS.find((a) => a.includes(last4))?.[0] ?? last4;
const istDay = (iso: string) => new Date(Date.parse(iso) + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const days = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: zero, error: zErr } = await sb
    .from("transactions")
    .select("id, card_last4, txn_at, txn_type, original_currency, original_amount, merchant")
    .neq("original_currency", "INR")
    .eq("amount_inr", 0);
  if (zErr) throw new Error(zErr.message);
  const { data: stmt, error: sErr } = await sb
    .from("transactions")
    .select("id, card_last4, txn_at, txn_type, amount_inr, raw_body, gmail_message_id")
    .like("gmail_message_id", "stmt:%")
    .eq("original_currency", "INR");
  if (sErr) throw new Error(sErr.message);

  const labelOf = (z: NonNullable<typeof zero>[number]) => `${z.card_last4} ${istDay(z.txn_at)} ${z.original_currency} ${z.original_amount} ${z.merchant ?? ""}`;
  // Every plausible pairing: same account and direction, within 3 days, same merchant.
  const candidates = (zero ?? []).flatMap((z) =>
    (stmt ?? [])
      .filter(
        (s) =>
          accountOf(s.card_last4) === accountOf(z.card_last4) &&
          s.txn_type === z.txn_type &&
          days(istDay(s.txn_at), istDay(z.txn_at)) <= 3 &&
          merchantsAgree(z.merchant, String(s.raw_body ?? "")),
      )
      .map((s) => ({ z, s, rate: Number(s.amount_inr) / Number(z.original_amount) })),
  );
  // Several same-merchant purchases on one trip (three Cargills shops on 30 July)
  // are told apart by the exchange rate: each currency-month's median implied rate
  // says which rupee amount belongs to which foreign amount.
  const rates = new Map<string, number>();
  const groups = new Map<string, number[]>();
  for (const c of candidates) {
    const k = `${c.z.original_currency}|${istDay(c.z.txn_at).slice(0, 7)}`;
    groups.set(k, [...(groups.get(k) ?? []), c.rate]);
  }
  for (const [k, rs] of groups) rates.set(k, rs.sort((a, b) => a - b)[Math.floor(rs.length / 2)]);
  const scored = candidates
    .map((c) => ({ ...c, dev: Math.abs(c.rate / rates.get(`${c.z.original_currency}|${istDay(c.z.txn_at).slice(0, 7)}`)! - 1) }))
    .filter((c) => c.dev <= 0.05)
    .sort((a, b) => a.dev - b.dev);

  const usedAlerts = new Set<string>();
  const usedStmt = new Set<string>();
  const plan: { alertId: string; stmtId: string; inr: number; label: string }[] = [];
  for (const c of scored) {
    if (usedAlerts.has(c.z.id) || usedStmt.has(c.s.id)) continue;
    usedAlerts.add(c.z.id);
    usedStmt.add(c.s.id);
    plan.push({ alertId: c.z.id, stmtId: c.s.id, inr: Number(c.s.amount_inr), label: `${labelOf(c.z)}  →  ₹${Number(c.s.amount_inr).toFixed(2)}  rate ${c.rate.toFixed(4)}  (${String(c.s.raw_body).slice(0, 44)})` });
  }
  plan.sort((a, b) => a.label.localeCompare(b.label));
  const unresolved = (zero ?? []).filter((z) => !usedAlerts.has(z.id)).map(labelOf);

  for (const p of plan) console.log(`  ${APPLY ? "FILLED" : "WOULD FILL"} ${p.label}`);
  for (const u of unresolved) console.log(`  NO PARTNER ${u}`);
  console.log(`\n${plan.length} alerts get their billed rupees; ${plan.length} duplicate statement rows removed; ${unresolved.length} left as they are.`);
  if (!APPLY) {
    console.log("Dry run: nothing written. Re-run with --apply.");
    return;
  }
  for (const p of plan) {
    const { data: updated, error: uErr } = await sb.from("transactions").update({ amount_inr: p.inr }).eq("id", p.alertId).eq("amount_inr", 0).select("id");
    if (uErr) throw new Error(`Update failed for ${p.label}: ${uErr.message}`);
    // Only remove the statement copy once the alert really holds its rupees.
    if (updated?.length !== 1) {
      console.log(`  SKIPPED ${p.label}: the alert changed since it was read, so its statement row stays.`);
      continue;
    }
    const { error: dErr } = await sb.from("transactions").delete().eq("id", p.stmtId).like("gmail_message_id", "stmt:%");
    if (dErr) throw new Error(`Delete failed for ${p.label}: ${dErr.message}`);
  }
  const { count } = await sb.from("transactions").select("id", { count: "exact", head: true }).neq("original_currency", "INR").eq("amount_inr", 0);
  console.log(`Foreign alerts still without a rupee value: ${count}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
