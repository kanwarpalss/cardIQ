/**
 * statements-reconcile.ts — compare card statements with cardIQ and add what's missing.
 *
 * Uses <dir>/parsed.json from statements-parse.ts. Only statements that balance
 * against their own printed totals are used. Purchases and refunds the statement
 * shows but cardIQ lacks are added; bank fees, tax, interest, bill payments and
 * cashback are reported but never added, since alert-based Spend has never
 * counted them. Every added row's gmail_message_id starts with "stmt:", so they
 * can be found or removed as a group.
 *
 * With --remove-unbilled it also removes cardIQ rows a balanced statement proves
 * were never charged (planRemovals: second copies, released holds, declined or
 * receipt-only rows). Removed rows are backed up to <dir>/removed-<time>.json and
 * their emails recorded in excluded_messages (migration 023) first, so no
 * reprocess, backfill or wipe re-creates them.
 *
 * READ-ONLY by default; writes <dir>/reconcile-report.json.
 * Run:  npx tsx scripts/statements-reconcile.ts --dir ~/.cardiq-statements [--remove-unbilled] [--apply]
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { categorizeFull } from "../src/lib/categorize";
import { resolveTxnCategory } from "../src/lib/category-taxonomy";
import { loadCategoryAliases } from "../src/lib/category-taxonomy-store";
import { cleanMerchant } from "../src/lib/merchant-clean";
import type { ParsedStatement, StatementLine } from "../src/lib/statements/parse";
import { BANK_EMAIL_SENDERS } from "../src/lib/cards/registry";
import { alertSpans, emiNamesPurchase, followCovered, matchLines, merchantsAgree, numberInUse, planRemovals, REISSUED_CARDS, secondPass, statementLineKey, type DbTxn, type RemovalCandidate, type StmtLineRef } from "../src/lib/statements/reconcile";

type Parsed = ParsedStatement & { uid: number; gmail_id: string; family: string; subject: string; date: string; file: string };

const APPLY = process.argv.includes("--apply");
const REMOVE = process.argv.includes("--remove-unbilled");
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
  // Who sent each alert: when a bank alert and a merchant receipt both fit one
  // statement line, the bank's alert keeps it and the receipt is the leftover.
  const senderOf = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("gmail_seen_messages").select("gmail_message_id, raw_from").eq("user_id", uid).not("txn_id", "is", null).order("gmail_message_id").range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const s of data ?? []) senderOf.set(s.gmail_message_id as string, String(s.raw_from ?? "").toLowerCase());
    if (!data || data.length < 1000) break;
  }
  const fromBank = (gmailId: string) => {
    const from = senderOf.get(gmailId);
    return from === undefined || BANK_EMAIL_SENDERS.some((s) => from.includes(s.toLowerCase()));
  };
  const txns: DbTxn[] = rows.map((r) => ({
    id: r.id as string,
    card_last4: r.card_last4 as string,
    amount_inr: Number(r.amount_inr),
    txn_type: r.txn_type as "debit" | "credit",
    day: istDay(r.txn_at as string),
    original_currency: (r.original_currency as string | null) ?? null,
    original_amount: r.original_amount == null ? null : Number(r.original_amount),
    fromBank: fromBank(r.gmail_message_id as string),
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
      // The key uses the printed number so it never changes as cardIQ's data does.
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

  // cardIQ rows inside a statement's dates that the statement doesn't contain.
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
  // A second cardIQ row with the same card, day and amount as one the statement
  // confirmed is most likely the same alert stored twice.
  const confirmed = new Set(matches.map((m) => `${m.txn.card_last4}|${m.txn.day}|${m.txn.txn_type}|${m.txn.amount_inr}`));
  const likelyDuplicates = notOnStatement.filter((t) => confirmed.has(`${t.card_last4}|${t.day}|${t.txn_type}|${t.amount_inr}`));
  const neverCharged = notOnStatement.filter((t) => !likelyDuplicates.includes(t));

  // ── Report ─────────────────────────────────────────────────────────────
  console.log(`Statements: ${statements.length} read, ${unreconciled.length} didn't balance (not used), ${duplicates.length} duplicate copies skipped, ${used.length} used.`);
  console.log(`Purchase/refund lines: ${lines.length}; already in cardIQ: ${matches.length}; missing: ${missing.length}.`);
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
  console.log("\nBy card (statement lines → already in cardIQ / missing):");
  for (const [card, c] of [...byCard].sort((a, b) => a[1].from.localeCompare(b[1].from))) {
    console.log(`  ${card}  ${c.from} → ${c.to}  ${String(c.lines).padStart(5)} lines  ${String(c.matched).padStart(5)} present  ${String(c.missing).padStart(5)} missing  (+${inr(c.missingDebit)} spend, ${inr(c.missingCredit)} refunds)`);
  }
  console.log("\nNot added (reported only):");
  for (const [kind, k] of otherKinds) console.log(`  ${kind.padEnd(13)} ${String(k.n).padStart(5)} lines  ${inr(k.total)}`);
  if (noCard.length) console.log(`  no card number on statement: ${noCard.length} lines`);
  const sum = (ts: DbTxn[]) => inr(ts.reduce((s, t) => s + t.amount_inr, 0));
  console.log(`\ncardIQ rows inside a statement's dates but not on it (listed for review, not changed):`);
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

  // ── Rows a balanced statement proves were never charged ───────────────────
  let removalPlan: ReturnType<typeof planRemovals> | null = null;
  if (REMOVE) {
    const statementDays = new Map<string, string[]>();
    for (const s of used) {
      for (const c of s.cardLast4s.length ? s.cardLast4s : [FAMILY_DEFAULT_CARD[s.family]].filter(Boolean)) {
        statementDays.set(accountOf(c), [...(statementDays.get(accountOf(c)) ?? []), s.date.slice(0, 10)]);
      }
    }
    const emiLines = used.flatMap((s) =>
      (s.lines as StatementLine[]).filter((l) => l.kind === "emi").map((l) => ({ ...l, account: accountOf(l.cardLast4 ?? FAMILY_DEFAULT_CARD[s.family] ?? "?") })),
    );
    const dupIds = new Set(likelyDuplicates.map((t) => t.id));
    const candidateIds = new Set([...likelyDuplicates, ...neverCharged].map((t) => t.id));
    // Identical copies of one alert: the statement matched one of them arbitrarily.
    const twinsOf = (t: DbTxn) => txns.filter((x) => x.id !== t.id && !candidateIds.has(x.id) && x.card_last4 === t.card_last4 && x.day === t.day && x.txn_type === t.txn_type && x.amount_inr === t.amount_inr);
    const lookupIds = [...candidateIds, ...likelyDuplicates.flatMap((t) => twinsOf(t).map((x) => x.id))];
    const refsByTxn = new Map<string, string[]>();
    for (let i = 0; i < lookupIds.length; i += 200) {
      for (const table of ["orders", "vouchers"] as const) {
        const { data, error } = await sb.from(table).select("*").in("txn_id", lookupIds.slice(i, i + 200));
        if (error) throw new Error(`${table}: ${error.message}`);
        for (const r of data ?? []) refsByTxn.set(r.txn_id as string, [...(refsByTxn.get(r.txn_id as string) ?? []), String(r.order_ref ?? r.id)]);
      }
    }
    const candidates: RemovalCandidate[] = [...likelyDuplicates, ...neverCharged].map((t) => {
      const merchant = (rowById.get(t.id)?.merchant as string | null) ?? null;
      return {
        id: t.id,
        kind: dupIds.has(t.id) ? "duplicate" : "not_on_statement",
        account: accountOf(t.card_last4),
        day: t.day,
        direction: t.txn_type,
        amount: t.amount_inr,
        foreign: t.original_currency && t.original_currency !== "INR" && t.original_amount != null ? { currency: t.original_currency, amount: t.original_amount } : null,
        followCovered: followCovered(statementDays.get(accountOf(t.card_last4)) ?? [], t.day),
        emiEvidence: t.txn_type === "debit" && emiLines.some((l) => l.account === accountOf(t.card_last4) && l.date >= t.day && Date.parse(l.date) - Date.parse(t.day) <= 45 * 86400000 && (merchantsAgree(merchant, l.description) || emiNamesPurchase(merchant, l.description))),
      };
    });
    removalPlan = planRemovals(candidates);
    const txnById = new Map(txns.map((t) => [t.id, t]));

    // Which copy of a duplicate goes: first one whose order's payment was refunded
    // by a release being removed (that payment was cancelled), then one no order
    // points at, so KP's confirmed order links stay where they are.
    const cancelledRefs = new Set(removalPlan.remove.filter((x) => x.reason !== "second_copy" && txnById.get(x.id)?.txn_type === "credit").flatMap((x) => refsByTxn.get(x.id) ?? []));
    const removePreference = (id: string) => ((refsByTxn.get(id) ?? []).some((ref) => cancelledRefs.has(ref)) ? 3 : refsByTxn.has(id) ? 1 : 2);
    for (const x of removalPlan.remove) {
      if (x.reason !== "second_copy" || !dupIds.has(x.id)) continue;
      const pick = [x.id, ...twinsOf(txnById.get(x.id)!).map((t) => t.id)].sort((a, b) => removePreference(b) - removePreference(a))[0];
      if (pick !== x.id) x.id = pick;
    }
    const unlinkedOrders = removalPlan.remove.filter((x) => refsByTxn.has(x.id)).length;
    if (unlinkedOrders) console.log(`\n${unlinkedOrders} removed row(s) carry an order or voucher; run sync-orders-offline.ts afterwards to re-pair them.`);
    const describe = (id: string) => {
      const t = txnById.get(id)!;
      const r = rowById.get(id)!;
      return `${t.card_last4} ${t.day} ${t.txn_type === "credit" ? "credit" : "debit "} ${inr(t.amount_inr).padStart(13)}${t.original_currency && t.original_currency !== "INR" ? ` (${t.original_currency} ${t.original_amount})` : ""}  ${String(r.merchant ?? "").slice(0, 28)}  [${String(r.gmail_message_id).slice(0, 16)}]`;
    };
    console.log(`\nRemovals (statements prove these were never charged):`);
    for (const reason of ["second_copy", "hold_released", "not_charged"] as const) {
      const rs = removalPlan.remove.filter((x) => x.reason === reason);
      console.log(`  ${reason.padEnd(14)} ${String(rs.length).padStart(4)} rows  ${sum(rs.map((x) => txnById.get(x.id)!))}`);
      if (process.argv.includes("--list")) for (const x of rs) console.log(`      ${describe(x.id)}`);
    }
    console.log(`Kept: ${removalPlan.keep.length} (shown_as_emi = the real purchase; next_statement_missing = KP to review)`);
    for (const k of removalPlan.keep) console.log(`  ${k.reason.padEnd(22)} ${describe(k.id)}`);
  }

  if (!APPLY) {
    console.log("\nDry run: nothing written. Re-run with --apply to add the missing lines" + (REMOVE ? " and remove the rows above." : "."));
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
  const categoryAliases = await loadCategoryAliases(sb, uid);

  const payload = missing.map((l) => {
    const rawKey = l.merchant.toLowerCase();
    const cleaned = cleanMerchant(l.merchant);
    const mapping = merchantMap.get(rawKey) ?? (cleaned ? merchantMap.get(cleaned.toLowerCase()) : undefined);
    const merchant = (mapping?.normalized_name as string | undefined) ?? cleaned ?? l.merchant;
    const resolved = resolveTxnCategory(
      mapping as { category?: string | null; subcategory?: string | null } | undefined,
      categorizeFull(merchant),
      categoryAliases,
    );
    return {
      user_id: uid,
      card_id: cardByLast4.get(l.cardLast4) ?? null,
      card_last4: l.cardLast4,
      amount_inr: l.amount,
      original_currency: l.foreign?.currency ?? "INR",
      original_amount: l.foreign?.amount ?? l.amount,
      low_confidence: false,
      merchant,
      category: resolved.category,
      subcategory: resolved.subcategory,
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
  console.log(`\nWrote ${written} rows. cardIQ now holds ${count} statement-sourced rows.`);

  if (!removalPlan || removalPlan.remove.length === 0) return;
  // The exclusion list must exist first, or reprocess would re-create every removed row.
  const probe = await sb.from("excluded_messages").select("gmail_message_id").limit(1);
  if (probe.error) throw new Error(`Run supabase/migrations/023_excluded_messages.sql in the Supabase SQL Editor first (${probe.error.message}). Nothing was removed.`);

  const removeIds = removalPlan.remove.map((x) => x.id);
  const reasonOf = new Map(removalPlan.remove.map((x) => [x.id, x.reason]));
  const full: Record<string, unknown>[] = [];
  for (let i = 0; i < removeIds.length; i += 200) {
    const { data, error } = await sb.from("transactions").select("*").in("id", removeIds.slice(i, i + 200));
    if (error) throw new Error(`Backup read failed: ${error.message}. Nothing was removed.`);
    full.push(...(data ?? []));
  }
  if (full.length !== removeIds.length) throw new Error(`Backup found ${full.length} of ${removeIds.length} rows; cardIQ changed since this run read it. Nothing was removed.`);
  if (full.some((r) => String(r.gmail_message_id).startsWith("stmt:"))) throw new Error("A statement-sourced row was planned for removal; that is a bug. Nothing was removed.");
  const backup = join(dir, `removed-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(backup, JSON.stringify(full.map((r) => ({ ...r, removal_reason: reasonOf.get(r.id as string) })), null, 1), { mode: 0o600 });
  console.log(`Backed up ${full.length} rows to ${backup}`);

  const exclusions = full.map((r) => ({
    user_id: uid,
    gmail_message_id: r.gmail_message_id as string,
    reason: `statement:${reasonOf.get(r.id as string)}`,
    detail: `${r.card_last4} ${istDay(r.txn_at as string)} ${r.txn_type} ${r.amount_inr}${r.original_currency !== "INR" ? ` ${r.original_currency} ${r.original_amount}` : ""}`,
  }));
  const { error: xErr } = await sb.from("excluded_messages").upsert(exclusions, { onConflict: "user_id,gmail_message_id" });
  if (xErr) throw new Error(`Recording exclusions failed: ${xErr.message}. Nothing was removed.`);

  let removed = 0;
  for (let i = 0; i < removeIds.length; i += 200) {
    const { data, error } = await sb.from("transactions").delete().in("id", removeIds.slice(i, i + 200)).not("gmail_message_id", "like", "stmt:%").select("id");
    if (error) throw new Error(`Removal failed after ${removed} rows: ${error.message}. Restore from ${backup} if needed.`);
    removed += data?.length ?? 0;
  }
  console.log(`Removed ${removed} of ${removeIds.length} planned rows; their emails are on the excluded list.`);
  if (removed !== removeIds.length) throw new Error("Fewer rows were removed than planned; check the backup file against cardIQ.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
