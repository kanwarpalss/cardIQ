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
  pairs.sort((a, b) => HOW_RANK[a.how] - HOW_RANK[b.how] || a.days - b.days);

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
