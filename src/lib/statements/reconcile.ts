// Pairs card-statement lines with transactions CardIQ already holds, so only charges
// the statement proves and CardIQ lacks get added. Pure: no database access.

import { createHash } from "crypto";
import type { StatementLine } from "./parse";

export type DbTxn = {
  id: string;
  card_last4: string;
  amount_inr: number;
  txn_type: "debit" | "credit";
  /** IST calendar day of txn_at, YYYY-MM-DD. */
  day: string;
  original_currency: string | null;
  original_amount: number | null;
  /** False for a merchant receipt or other non-bank email stored as a charge. */
  fromBank?: boolean;
};

export type StmtLineRef = StatementLine & { cardLast4: string; key: string };

export type Match = { line: StmtLineRef; txn: DbTxn; how: "exact" | "foreign" | "foreign_inr_approx" };

/** Days a bank's printed date may differ from the alert's date (posting lag, timezones). */
export const DATE_WINDOW_DAYS = 3;

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
}

/** How a line and a stored transaction agree on money, best first; null if they don't. */
export function amountAgreement(line: StatementLine, txn: DbTxn): Match["how"] | null {
  const currency = (txn.original_currency ?? "INR").toUpperCase();
  if (currency === "INR") return Math.abs(Number(txn.amount_inr) - line.amount) <= 0.005 ? "exact" : null;
  if (line.foreign && line.foreign.currency === currency && txn.original_amount != null) {
    return Math.abs(Number(txn.original_amount) - line.foreign.amount) <= 0.005 ? "foreign" : null;
  }
  // A foreign alert whose statement line doesn't show the currency: CardIQ's INR is
  // an estimate at that day's rate, so allow the bank's conversion to differ by 5%.
  if (!line.foreign && Number(txn.amount_inr) > 0) {
    return Math.abs(Number(txn.amount_inr) - line.amount) / line.amount <= 0.05 ? "foreign_inr_approx" : null;
  }
  return null;
}

const HOW_RANK: Record<Match["how"], number> = { exact: 0, foreign: 0, foreign_inr_approx: 1 };

/**
 * One-to-one pairing: every candidate pair (same card, same direction, money agrees,
 * dates within the window) is ranked by money agreement, then date distance, and
 * taken greedily, so two identical ₹196 coffees on one day pair with two alerts,
 * never one alert twice.
 */
/**
 * A reissued card gets a new number but stays the same account, and its alerts
 * keep the number in use that day. `accountOf` maps every number to one account
 * key so a statement line can pair with an alert under the old or new number.
 */
export type AccountOf = (last4: string) => string;

/**
 * Reissue chains that never share a statement, so they can't be inferred from one.
 * Citi prints no number; its alerts show 6589 until Jan 2020, 0817 during 2020,
 * then 6016 (240 statement lines pair with alerts under those numbers). HDFC
 * Infinia's alerts move 0204 → 8609 → 5906, with lines pairing across each change.
 */
export const REISSUED_CARDS: readonly (readonly string[])[] = [
  ["6589", "0817", "6016"],
  ["0204", "8609", "5906"],
];
const sameNumber: AccountOf = (last4) => last4;

export function matchLines(
  lines: StmtLineRef[],
  txns: DbTxn[],
  accountOf: AccountOf = sameNumber,
): { matches: Match[]; unmatchedLines: StmtLineRef[]; unmatchedTxns: DbTxn[] } {
  const byAccount = new Map<string, DbTxn[]>();
  for (const t of txns) byAccount.set(accountOf(t.card_last4), [...(byAccount.get(accountOf(t.card_last4)) ?? []), t]);

  const pairs: { line: StmtLineRef; txn: DbTxn; how: Match["how"]; days: number }[] = [];
  for (const line of lines) {
    for (const txn of byAccount.get(accountOf(line.cardLast4)) ?? []) {
      if (txn.txn_type !== line.direction) continue;
      const days = Math.abs(dayDiff(line.date, txn.day));
      if (days > DATE_WINDOW_DAYS) continue;
      const how = amountAgreement(line, txn);
      if (how) pairs.push({ line, txn, how, days });
    }
  }
  // On a tie the bank's own alert takes the line, so a receipt for the same charge is the leftover.
  const notBank = (t: DbTxn) => Number(t.fromBank === false);
  pairs.sort((a, b) => HOW_RANK[a.how] - HOW_RANK[b.how] || a.days - b.days || notBank(a.txn) - notBank(b.txn));

  const usedLines = new Set<string>();
  const usedTxns = new Set<string>();
  const matches: Match[] = [];
  for (const p of pairs) {
    if (usedLines.has(p.line.key) || usedTxns.has(p.txn.id)) continue;
    usedLines.add(p.line.key);
    usedTxns.add(p.txn.id);
    matches.push({ line: p.line, txn: p.txn, how: p.how });
  }
  return {
    matches,
    unmatchedLines: lines.filter((l) => !usedLines.has(l.key)),
    unmatchedTxns: txns.filter((t) => !usedTxns.has(t.id)),
  };
}

/** First and last day each card number has stored alerts. */
export function alertSpans(txns: DbTxn[]): Map<string, [string, string]> {
  const spans = new Map<string, [string, string]>();
  for (const t of txns) {
    const s = spans.get(t.card_last4);
    if (!s) spans.set(t.card_last4, [t.day, t.day]);
    else spans.set(t.card_last4, [t.day < s[0] ? t.day : s[0], t.day > s[1] ? t.day : s[1]]);
  }
  return spans;
}

/**
 * Which number a reissued account carried on a given day. The printed number wins
 * when its alerts span that day (reissues overlap for a month or two); otherwise
 * the number whose alerts are nearest in time; the printed number if none have any.
 */
export function numberInUse(account: string[], day: string, spans: Map<string, [string, string]>, printed: string): string {
  const gapOf = (last4: string) => {
    const s = spans.get(last4);
    if (!s) return Infinity;
    return day < s[0] ? dayDiff(s[0], day) : day > s[1] ? dayDiff(day, s[1]) : 0;
  };
  if (gapOf(printed) === 0) return printed;
  let best = printed;
  let bestGap = gapOf(printed);
  for (const last4 of account) {
    const gap = gapOf(last4);
    if (gap < bestGap) {
      bestGap = gap;
      best = last4;
    }
  }
  return best;
}

/** Days allowed between an alert and a late-posted statement line. */
export const LATE_WINDOW_DAYS = 10;
/** Hotels and car rentals bill at checkout, up to three weeks after the hold alert. */
export const REPRICE_WINDOW_DAYS = 21;

const STOP = new Set(["private", "limited", "india", "bangalore", "bengaluru", "mumbai", "gurgaon", "gurugram", "delhi", "noida", "pune", "chennai", "hyderabad", "https", "http", "services", "service", "technologies", "technology", "payments", "payment", "online", "store", "stores", "hotels", "travel", "restaurants", "retail", "smartbuy", "razorpay"]);

/** True when a stored merchant name plausibly names the statement's merchant. */
export function merchantsAgree(stored: string | null, statementDescription: string): boolean {
  if (!stored) return false;
  const haystack = statementDescription.toLowerCase().replace(/[^a-z]/g, "");
  return stored
    .toLowerCase()
    .split(/[^a-z]+/)
    .some((tok) => tok.length >= 4 && !STOP.has(tok) && haystack.includes(tok));
}

export type SecondPass = {
  /** Same amount, posted 4–10 days from the alert. Already in CardIQ. */
  latePosted: Match[];
  /** Same merchant within 10 days, different amount: a hold or tip settled at another figure. */
  repriced: { line: StmtLineRef; txn: DbTxn }[];
  unmatchedLines: StmtLineRef[];
  unmatchedTxns: DbTxn[];
};

/**
 * After the strict pass, pairs what's left that is clearly the same purchase seen
 * twice: an exact amount posted late, or the same merchant at a settled amount
 * (hotel and car-rental holds). Neither may be added, or Spend would count it twice.
 */
export function secondPass(
  lines: StmtLineRef[],
  txns: DbTxn[],
  merchantOf: (txnId: string) => string | null,
  accountOf: AccountOf = sameNumber,
): SecondPass {
  const usedLines = new Set<string>();
  const usedTxns = new Set<string>();
  const latePosted: Match[] = [];
  const repriced: SecondPass["repriced"] = [];
  const candidates = (line: StmtLineRef, window: number) =>
    txns
      .filter((t) => !usedTxns.has(t.id) && accountOf(t.card_last4) === accountOf(line.cardLast4) && t.txn_type === line.direction)
      .map((t) => ({ t, days: Math.abs(dayDiff(line.date, t.day)) }))
      .filter((c) => c.days <= window)
      .sort((a, b) => a.days - b.days);

  for (const line of lines) {
    const hit = candidates(line, LATE_WINDOW_DAYS).find((c) => amountAgreement(line, c.t) === "exact" || amountAgreement(line, c.t) === "foreign");
    if (!hit) continue;
    usedLines.add(line.key);
    usedTxns.add(hit.t.id);
    latePosted.push({ line, txn: hit.t, how: "exact" });
  }
  for (const line of lines) {
    if (usedLines.has(line.key)) continue;
    const hit = candidates(line, REPRICE_WINDOW_DAYS).find((c) => {
      const ratio = Number(c.t.amount_inr) / line.amount;
      return ratio >= 0.5 && ratio <= 2 && merchantsAgree(merchantOf(c.t.id), line.description);
    });
    if (!hit) continue;
    usedLines.add(line.key);
    usedTxns.add(hit.t.id);
    repriced.push({ line, txn: hit.t });
  }
  return {
    latePosted,
    repriced,
    unmatchedLines: lines.filter((l) => !usedLines.has(l.key)),
    unmatchedTxns: txns.filter((t) => !usedTxns.has(t.id)),
  };
}

/**
 * Stable id for a statement line, used as the row's gmail_message_id ("stmt:" prefix
 * marks every statement-sourced row). The occurrence number keeps two identical
 * lines in one statement distinct, and re-running produces the same ids.
 */
export function statementLineKey(statementGmailId: string, line: StatementLine & { cardLast4: string }, occurrence: number): string {
  const basis = [line.cardLast4, line.date, line.direction, line.amount.toFixed(2), line.description, occurrence].join("|");
  return `stmt:${statementGmailId}:${createHash("sha256").update(basis).digest("hex").slice(0, 16)}`;
}

/**
 * True when statements cover `day` and the `followDays` after it without a gap:
 * a charge that hasn't posted by then was never billed. `statementDays` are the
 * account's statement dates (YYYY-MM-DD); a gap longer than `maxGapDays` means a
 * statement is missing or still locked.
 */
export function followCovered(statementDays: string[], day: string, followDays = 21, maxGapDays = 35): boolean {
  const ds = [...new Set(statementDays)].sort();
  const before = ds.filter((d) => d <= day).pop();
  const after = ds.find((d) => dayDiff(d, day) >= followDays);
  if (!before || !after) return false;
  const run = ds.filter((d) => d >= before && d <= after);
  return run.every((d, i) => i === 0 || dayDiff(d, run[i - 1]) <= maxGapDays);
}

/** A CardIQ row inside a balanced statement's dates that the statement doesn't show. */
export type RemovalCandidate = {
  id: string;
  /** "duplicate": a twin of a row the statement confirms once. */
  kind: "duplicate" | "not_on_statement";
  account: string;
  day: string;
  direction: "debit" | "credit";
  amount: number;
  foreign: { currency: string; amount: number } | null;
  /** Statements cover the 21 days after this row, so a late posting would show. */
  followCovered: boolean;
  /** The statement bills this purchase as EMI instalments instead of one line. */
  emiEvidence: boolean;
};

export type RemovalReason = "second_copy" | "hold_released" | "not_charged";
export type KeepReason = "next_statement_missing" | "shown_as_emi";

/** Days between a hold and its release for the two to count as one cancelled charge. */
export const HOLD_RELEASE_DAYS = 7;

/**
 * Decides which rows a statement proves were never charged. A balanced statement
 * is complete, so anything it doesn't show is a hold, a declined attempt or a
 * second copy; the exceptions are kept and listed for KP.
 */
export function planRemovals(cands: RemovalCandidate[]): { remove: { id: string; reason: RemovalReason }[]; keep: { id: string; reason: KeepReason }[] } {
  const remove: { id: string; reason: RemovalReason }[] = [];
  const keep: { id: string; reason: KeepReason }[] = [];
  const done = new Set<string>();
  const sameMoney = (a: RemovalCandidate, b: RemovalCandidate) =>
    a.foreign && b.foreign ? a.foreign.currency === b.foreign.currency && Math.abs(a.foreign.amount - b.foreign.amount) <= 0.005 : Math.abs(a.amount - b.amount) <= 0.005;

  for (const c of cands) if (!done.has(c.id) && c.kind === "duplicate") (done.add(c.id), remove.push({ id: c.id, reason: "second_copy" }));

  // A hold and its release cancel out whether or not the next statement is here.
  const open = cands.filter((c) => !done.has(c.id));
  for (const d of open.filter((c) => c.direction === "debit")) {
    const release = open
      .filter((r) => r.direction === "credit" && !done.has(r.id) && !done.has(d.id) && r.account === d.account && sameMoney(d, r) && Math.abs(dayDiff(r.day, d.day)) <= HOLD_RELEASE_DAYS)
      .sort((a, b) => Math.abs(dayDiff(a.day, d.day)) - Math.abs(dayDiff(b.day, d.day)))[0];
    if (!release) continue;
    for (const id of [d.id, release.id]) (done.add(id), remove.push({ id, reason: "hold_released" }));
  }

  // The bank shows an EMI purchase as instalments: one alert is the real spend.
  const emiKept = new Set<string>();
  for (const c of cands.filter((x) => !done.has(x.id) && x.emiEvidence)) {
    const k = `${c.account}|${c.day}|${c.direction}|${c.amount.toFixed(2)}`;
    done.add(c.id);
    if (emiKept.has(k)) remove.push({ id: c.id, reason: "second_copy" });
    else (emiKept.add(k), keep.push({ id: c.id, reason: "shown_as_emi" }));
  }

  for (const c of cands.filter((x) => !done.has(x.id))) {
    if (c.followCovered) remove.push({ id: c.id, reason: "not_charged" });
    else keep.push({ id: c.id, reason: "next_statement_missing" });
  }
  return { remove, keep };
}

/**
 * True when a merchant-EMI instalment line ("M-RAZORPAY PAYMENTS ,P:01,…") names
 * the stored purchase's merchant. Such a purchase never appears as one statement
 * line, so the instalments are its only evidence. Compared letter for letter,
 * because merchant-EMI names are often all generic words merchantsAgree ignores.
 */
export function emiNamesPurchase(storedMerchant: string | null, emiDescription: string): boolean {
  const named = /^M-([^,]+),/i.exec(emiDescription.trim())?.[1];
  if (!storedMerchant || !named) return false;
  const letters = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const a = letters(storedMerchant);
  const b = letters(named);
  return a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a));
}
