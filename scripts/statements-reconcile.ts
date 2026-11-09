/**
 * statements-reconcile.ts — compare card statements with CardIQ and add what's missing.
 *
 * Uses <dir>/parsed.json from statements-parse.ts. Only statements that balance
 * against their own printed totals are used. Purchases and refunds the statement
 * shows but CardIQ lacks are added; bank fees, tax, interest, bill payments and
 * cashback are reported but never added, since alert-based Spend has never
 * counted them. Every added row's gmail_message_id starts with "stmt:", so they
 * can be found or removed as a group.
 *
 * READ-ONLY by default; writes <dir>/reconcile-report.json.
 * Run:  npx tsx scripts/statements-reconcile.ts --dir ~/.cardiq-statements [--apply]
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { categorizeFull } from "../src/lib/categorize";
import { cleanMerchant } from "../src/lib/merchant-clean";
import type { ParsedStatement, StatementLine } from "../src/lib/statements/parse";
import { alertSpans, matchLines, numberInUse, REISSUED_CARDS, secondPass, statementLineKey, type DbTxn, type StmtLineRef } from "../src/lib/statements/reconcile";

type Parsed = ParsedStatement & { uid: number; gmail_id: string; family: string; subject: string; date: string; file: string };

const APPLY = process.argv.includes("--apply");
const dirIdx = process.argv.indexOf("--dir");
if (dirIdx < 0) throw new Error("Pass --dir <folder>");
const dir = process.argv[dirIdx + 1];

// Citi statements never print the card number; KP's only Citi card is 6589 (Citi's own emails).
// IDFC's 2023 statements omit it; every later one shows 3661 as the primary card.
const FAMILY_DEFAULT_CARD: Record<string, string> = { citi: "6589", idfc: "3661" };
const ADDABLE = new Set(["purchase", "refund"]);

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const istDay = (iso: string) => new Date(Date.parse(iso) + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

async function main() {
  const statements: Parsed[] = JSON.parse(readFileSync(join(dir, "parsed.json"), "utf8"));
  const unreconciled = statements.filter((s) => !s.tie.ok);

  // A forwarded copy of a statement already received directly would double every line.
  const seenTotals = new Map<string, string>();
  const used: Parsed[] = [];
  const duplicates: string[] = [];
  for (const s of statements.filter((x) => x.tie.ok).sort((a, b) => Number(a.family === "forwarded") - Number(b.family === "forwarded"))) {
    const card = s.cardLast4s[0] ?? FAMILY_DEFAULT_CARD[s.family] ?? "?";
    const sig = `${card}|${s.tie.previous}|${s.tie.totalDue}|${s.tie.debits}|${s.tie.credits}`;
    if (seenTotals.has(sig)) {
      duplicates.push(`${s.subject} (${s.date.slice(0, 10)}) = copy of ${seenTotals.get(sig)}`);
      continue;
    }
    seenTotals.set(sig, `${s.subject} (${s.date.slice(0, 10)})`);
    used.push(s);
  }

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: settings, error: sErr } = await sb.from("user_settings").select("user_id").limit(1).single();
  if (sErr || !settings) throw new Error(`No user: ${sErr?.message}`);
  const uid = settings.user_id as string;

  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("transactions")
      .select("id, card_last4, amount_inr, txn_type, txn_at, original_currency, original_amount, merchant, gmail_message_id")
      .eq("user_id", uid)
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const txns: DbTxn[] = rows.map((r) => ({
    id: r.id as string,
    card_last4: r.card_last4 as string,
    amount_inr: Number(r.amount_inr),
    txn_type: r.txn_type as "debit" | "credit",
    day: istDay(r.txn_at as string),
    original_currency: (r.original_currency as string | null) ?? null,
    original_amount: r.original_amount == null ? null : Number(r.original_amount),
  }));

  // Reissued cards: numbers printed together on one statement are one account,
  // plus the chains in REISSUED_CARDS that never share a statement.
  const parent = new Map<string, string>();
  const find = (a: string): string => (parent.get(a) ?? a) === a ? a : find(parent.get(a)!);
  const union = (a: string, b: string) => {
    for (const n of [a, b]) if (!parent.has(n)) parent.set(n, n);
    if (find(a) !== find(b)) parent.set(find(a), find(b));
  };
  for (const s of used) for (const c of s.cardLast4s.slice(1)) union(s.cardLast4s[0], c);
  for (const chain of REISSUED_CARDS) for (const n of chain.slice(1)) union(chain[0], n);
  const accountOf = (last4: string) => find(last4);
  const members = (last4: string) => [...new Set([last4, ...[...parent.keys()].filter((k) => find(k) === find(last4))])];
  const spans = alertSpans(txns);

  const lines: (StmtLineRef & { statement: Parsed; printedCard: string })[] = [];
  const noCard: string[] = [];
  const otherKinds = new Map<string, { n: number; total: number }>();
  for (const s of used) {
    const occurrences = new Map<string, number>();
    for (const l of s.lines as StatementLine[]) {
      const printed = l.cardLast4 ?? FAMILY_DEFAULT_CARD[s.family] ?? null;
      if (!ADDABLE.has(l.kind)) {
        const k = otherKinds.get(l.kind) ?? { n: 0, total: 0 };
        otherKinds.set(l.kind, { n: k.n + 1, total: k.total + l.amount });
        continue;
      }
      if (!printed) {
        noCard.push(`${s.subject}: ${l.date} ${l.description} ${l.amount}`);
        continue;
      }
      // The key uses the printed number so it never changes as CardIQ's data does.
      const base = [printed, l.date, l.direction, l.amount.toFixed(2), l.description].join("|");
      const n = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, n);
      const cardLast4 = numberInUse(members(printed), l.date, spans, printed);
      lines.push({ ...l, cardLast4, printedCard: printed, key: statementLineKey(s.gmail_id, { ...l, cardLast4: printed }, n), statement: s });
    }
  }
  const accounts = new Map<string, Set<string>>();
  for (const k of new Set([...parent.keys(), ...[...parent.keys()].map(find)])) accounts.set(find(k), new Set([...(accounts.get(find(k)) ?? []), k]));
  console.log(`Reissued-card accounts: ${[...accounts.values()].filter((a) => a.size > 1).map((a) => [...a].join("/")).join(", ")}`);
  const rowById = new Map(rows.map((r) => [r.id as string, r]));

  const strict = matchLines(lines, txns, accountOf);
  const second = secondPass(strict.unmatchedLines, strict.unmatchedTxns, (id) => (rowById.get(id)?.merchant as string | null) ?? null, accountOf);
  const matches = [...strict.matches, ...second.latePosted];
  const unmatchedTxns = second.unmatchedTxns;
  const missing = second.unmatchedLines as typeof lines;

  // CardIQ rows inside a statement's dates that the statement doesn't contain.
  // The last few days of a period are left out: a charge made then often posts on
  // the next statement.
  const windows = used.map((s) => {
    const ds = (s.lines as StatementLine[]).map((l) => l.date).sort();
    const to = ds.length ? new Date(Date.parse(`${ds[ds.length - 1]}T00:00:00Z`) - 3 * 86400000).toISOString().slice(0, 10) : undefined;
    return { cards: new Set([...(s.cardLast4s.length ? s.cardLast4s : [FAMILY_DEFAULT_CARD[s.family]])]), from: ds[0], to: to ?? "" };
  });
  const notOnStatement = unmatchedTxns.filter((t) =>
    windows.some((w) => w.from && w.cards.has(t.card_last4) && t.day >= w.from && t.day <= w.to),
  );
  // A second CardIQ row with the same card, day and amount as one the statement
  // confirmed is most likely the same alert stored twice.
  const confirmed = new Set(matches.map((m) => `${m.txn.card_last4}|${m.txn.day}|${m.txn.txn_type}|${m.txn.amount_inr}`));
  const likelyDuplicates = notOnStatement.filter((t) => confirmed.has(`${t.card_last4}|${t.day}|${t.txn_type}|${t.amount_inr}`));
  const neverCharged = notOnStatement.filter((t) => !likelyDuplicates.includes(t));

  // ── Report ─────────────────────────────────────────────────────────────
  console.log(`Statements: ${statements.length} read, ${unreconciled.length} didn't balance (not used), ${duplicates.length} duplicate copies skipped, ${used.length} used.`);
  console.log(`Purchase/refund lines: ${lines.length}; already in CardIQ: ${matches.length}; missing: ${missing.length}.`);
  const how: Record<string, number> = {};
  for (const m of matches) how[m.how] = (how[m.how] ?? 0) + 1;
  console.log(`  matched by: ${JSON.stringify(how)} (+${second.latePosted.length} posted 4–10 days after the alert)`);
  console.log(`  same purchase, bank settled a different amount (holds, tips): ${second.repriced.length} — not added, listed for review.`);

  const byCard = new Map<string, { lines: number; matched: number; missing: number; missingDebit: number; missingCredit: number; from: string; to: string }>();
  for (const l of lines) {
    const c = byCard.get(l.cardLast4) ?? { lines: 0, matched: 0, missing: 0, missingDebit: 0, missingCredit: 0, from: l.date, to: l.date };
    c.lines++;
    if (l.date < c.from) c.from = l.date;
    if (l.date > c.to) c.to = l.date;
    byCard.set(l.cardLast4, c);
  }
  for (const m of matches) byCard.get(m.line.cardLast4)!.matched++;
  for (const l of missing) {
    const c = byCard.get(l.cardLast4)!;
    c.missing++;
    if (l.direction === "debit") c.missingDebit += l.amount;
    else c.missingCredit += l.amount;
  }
  console.log("\nBy card (statement lines → already in CardIQ / missing):");
  for (const [card, c] of [...byCard].sort((a, b) => a[1].from.localeCompare(b[1].from))) {
    console.log(`  ${card}  ${c.from} → ${c.to}  ${String(c.lines).padStart(5)} lines  ${String(c.matched).padStart(5)} present  ${String(c.missing).padStart(5)} missing  (+${inr(c.missingDebit)} spend, ${inr(c.missingCredit)} refunds)`);
  }
  console.log("\nNot added (reported only):");
  for (const [kind, k] of otherKinds) console.log(`  ${kind.padEnd(13)} ${String(k.n).padStart(5)} lines  ${inr(k.total)}`);
  if (noCard.length) console.log(`  no card number on statement: ${noCard.length} lines`);
  const sum = (ts: DbTxn[]) => inr(ts.reduce((s, t) => s + t.amount_inr, 0));
  console.log(`\nCardIQ rows inside a statement's dates but not on it (listed for review, not changed):`);
  console.log(`  likely stored twice: ${likelyDuplicates.length} (${sum(likelyDuplicates)})`);
  console.log(`  bank never charged (declined, cancelled, or another card): ${neverCharged.length} (${sum(neverCharged)})`);

  writeFileSync(
    join(dir, "reconcile-report.json"),
    JSON.stringify(
      {
        unreconciled: unreconciled.map((s) => `${s.subject} (${s.date.slice(0, 10)})`),
        duplicates,
        missing: missing.map((l) => ({ card: l.cardLast4, date: l.date, direction: l.direction, amount: l.amount, foreign: l.foreign, description: l.description, statement: l.statement.subject, key: l.key })),
        approxMatches: matches.filter((m) => m.how === "foreign_inr_approx").map((m) => ({ line: `${m.line.cardLast4} ${m.line.date} ${m.line.amount} ${m.line.description}`, txn: rowById.get(m.txn.id) })),
        repriced: second.repriced.map((r) => ({ statement: `${r.line.cardLast4} ${r.line.date} ${r.line.amount} ${r.line.description}`, cardiq: rowById.get(r.txn.id) })),
        likelyDuplicates: likelyDuplicates.map((t) => rowById.get(t.id)),
        neverCharged: neverCharged.map((t) => rowById.get(t.id)),
        noCard,
      },
      null,
      1,
    ),
    { mode: 0o600 },
  );

  if (!APPLY) {
    console.log("\nDry run: nothing written. Re-run with --apply to add the missing lines.");
    return;
  }

  // ── Apply ──────────────────────────────────────────────────────────────
  const [cardsRes, mappingsRes] = await Promise.all([
    sb.from("cards").select("id, last4").eq("user_id", uid),
    sb.from("merchant_mappings").select("raw_name, normalized_name, category, subcategory").eq("user_id", uid),
  ]);
  if (cardsRes.error) throw new Error(cardsRes.error.message);
  if (mappingsRes.error) throw new Error(mappingsRes.error.message);
  const cardByLast4 = new Map((cardsRes.data ?? []).map((c) => [c.last4 as string, c.id as string]));
  const merchantMap = new Map((mappingsRes.data ?? []).map((m) => [String(m.raw_name).toLowerCase(), m]));

  const payload = missing.map((l) => {
    const rawKey = l.merchant.toLowerCase();
    const cleaned = cleanMerchant(l.merchant);
    const mapping = merchantMap.get(rawKey) ?? (cleaned ? merchantMap.get(cleaned.toLowerCase()) : undefined);
    const merchant = (mapping?.normalized_name as string | undefined) ?? cleaned ?? l.merchant;
    const ruled = categorizeFull(merchant);
    return {
      user_id: uid,
      card_id: cardByLast4.get(l.cardLast4) ?? null,
      card_last4: l.cardLast4,
      amount_inr: l.amount,
      original_currency: l.foreign?.currency ?? "INR",
      original_amount: l.foreign?.amount ?? l.amount,
      low_confidence: false,
      merchant,
      category: (mapping?.category as string | undefined) ?? ruled.category,
      subcategory: mapping ? ((mapping.subcategory as string | null) ?? null) : ruled.subcategory,
      txn_type: l.direction,
      // Statements give a day, not a time: noon IST keeps it on the right day in every view.
      txn_at: new Date(`${l.date}T12:00:00+05:30`).toISOString(),
      gmail_message_id: l.key,
      raw_subject: `Card statement: ${l.statement.subject}`,
      raw_body: `${l.date} | ${l.description} | ${l.amount.toFixed(2)} ${l.direction === "credit" ? "Cr" : "Dr"}${l.foreign ? ` | ${l.foreign.currency} ${l.foreign.amount}` : ""} — line from the card statement emailed ${l.statement.date.slice(0, 10)}`,
    };
  });

  let written = 0;
  for (let i = 0; i < payload.length; i += 200) {
    const chunk = payload.slice(i, i + 200);
    const { error } = await sb.from("transactions").upsert(chunk, { onConflict: "user_id,gmail_message_id", ignoreDuplicates: true });
    if (error) throw new Error(`Write failed after ${written} rows: ${error.message}`);
    written += chunk.length;
  }
  const { count, error: cErr } = await sb.from("transactions").select("id", { count: "exact", head: true }).eq("user_id", uid).like("gmail_message_id", "stmt:%");
  if (cErr) throw new Error(cErr.message);
  console.log(`\nWrote ${written} rows. CardIQ now holds ${count} statement-sourced rows.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
