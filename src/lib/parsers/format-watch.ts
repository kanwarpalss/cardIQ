// Unrecognized-format watch — a safety net independent of the parsers it
// watches over.
//
// Every parser (axis.ts, hdfc.ts, …) and the generic-sniffer fallback both
// key off SOME expected shape: a subject pattern, a transactional verb
// (debited/spent/credited/…), etc. When a bank changes its email template,
// both can miss it silently — that's exactly what happened in 2026-10 when
// Axis switched to a "Transaction alert on Axis Bank Credit Card" subject
// with no verb anywhere in the body (see axis.ts's SUBJECT_GENERIC_ALERT_RE
// comment). A txn-shaped email vanished with no error, no low-confidence
// row, nothing — because the generic sniffer's own verb requirement is what
// kept it out too.
//
// This check is deliberately dumber than either: does a known bank's email
// mention one of the user's own card numbers, full stop. No verb needed, no
// currency needed. It reuses the generic-sniffer's own benign-pattern vetoes
// (marketing, bill-payment/statement/autopay-reminder notices, support-reply
// threads) so it isn't flooded by categories that are already correctly
// handled — see MARKETING_SIGNALS_RE / NON_TRANSACTION_NOTIFICATION_RE in
// generic-sniffer.ts (ARCH-04: reused, not re-derived). It does NOT reuse
// TXN_VERB_RE — that's the exact gap this exists to catch. A first real-data
// run (2026-10-25) without any veto returned 894 "candidates" dominated by
// four categories genericSniff already handles correctly once a verb isn't
// required to exclude them: declined-transaction notices, AutoPay mandate
// lifecycle emails (activation/reminder — not the executed charge itself),
// HDFC's information@/informations@ marketing sender (distinct from its real
// alerts@hdfcbank.bank.in), and support-reply correspondence threads beyond
// the narrow reward/service-request wording generic-sniffer's own
// SUPPORT_REPLY_THREAD_RE looks for. Those four got dedicated vetoes below.

import { MARKETING_SIGNALS_RE, NON_TRANSACTION_NOTIFICATION_RE } from "./generic-sniffer";

export type SeenRow = {
  gmail_message_id: string;
  raw_from: string;
  raw_subject: string;
  raw_body: string;
  internal_date?: number | null;
};

export type FormatWatchCandidate = {
  gmail_message_id: string;
  sender: string;
  subject: string;
  matched_last4: string;
  snippet: string;
  internal_date?: number | null;
};

function isKnownBankSender(sender: string, bankDomains: readonly string[]): boolean {
  const lower = sender.toLowerCase();
  return bankDomains.some((d) => lower.includes(d.toLowerCase()));
}

// Same shape as generic-sniffer's LAST4_RE (XX1234, **1234, ending 1234,
// "card no. 1234") but kept standalone on purpose: this check must never
// silently narrow just because that file's regex changes for an unrelated
// reason.
const LAST4_NEAR_RE =
  /(?:XX|\*\*|ending\s+(?:(?:with|in)\s+)?|card\s+(?:no\.?|number)?\s*:?\s*X?X?)\s*(\d{4})\b/gi;

// A bank's explicit transaction-alert subject is independent evidence that
// deserves attention even when its card field/template changes. Never let a
// marketing footer or an unregistered/retired card silently hide this class.
const EXPLICIT_ALERT_RE = /^(?:Transaction alert on Axis Bank Credit Card(?: no\. XX\d{4})?|We noticed a transaction on your Credit Card|A payment was made using your Credit Card|Alert\s*:\s*Update on your HDFC Bank Credit Card|Transaction alert for your ICICI Bank credit card|Credit Card Transaction Alert|(?:Transaction confirmation|Credit Transaction|Cancellation of transaction) on your Citibank credit card|Provisional credit to your Citibank credit card)$/i;

// Format-watch-specific vetoes — categories that look transactional only
// because we dropped the verb requirement, each confirmed from the
// 2026-10-25 real-data run (see file header):
const RE_THREAD_RE = /^Re:/i;                       // user's own correspondence with the bank
const DECLINED_RE = /\bdeclined\b/i;                // no money moved
const AUTOPAY_LIFECYCLE_RE = /auto\s*pay.*(activated|reminder)/i; // mandate setup, not the executed charge
const MARKETING_SENDER_LOCAL_PART_RE = /^informations?$/i;  // local part excludes the @ delimiter

function isBenignNotification(sender: string, subject: string, combined: string): boolean {
  if (RE_THREAD_RE.test(subject)) return true;
  if (DECLINED_RE.test(subject)) return true;
  if (AUTOPAY_LIFECYCLE_RE.test(subject)) return true;
  const localPart = sender.match(/<?([^<>@\s]+)@/)?.[1] ?? "";
  if (MARKETING_SENDER_LOCAL_PART_RE.test(localPart)) return true;
  if (NON_TRANSACTION_NOTIFICATION_RE.test(combined)) return true;

  let marketingHits = 0;
  const marketingRe = new RegExp(MARKETING_SIGNALS_RE.source, "gi");
  while (marketingRe.exec(combined)) {
    marketingHits++;
    if (marketingHits >= 2) return true;
  }
  return false;
}

/**
 * Scan already-fetched, not-yet-matched bank emails (gmail_seen_messages rows
 * with txn_id IS NULL) for explicit transaction alerts, or other suspicious
 * messages mentioning a card the user actually has.
 * Pure function — no DB/network access — so it's shared by the one-off sweep
 * script and any periodic job without risk of the two drifting apart.
 */
export function findUnrecognizedFormatCandidates(
  rows: SeenRow[],
  knownLast4s: Set<string>,
  bankDomains: readonly string[],
): FormatWatchCandidate[] {
  const out: FormatWatchCandidate[] = [];
  for (const row of rows) {
    if (!isKnownBankSender(row.raw_from, bankDomains)) continue;
    const combined = `${row.raw_subject} ${row.raw_body}`.replace(/\s+/g, " ").trim();
    const explicitAlert = EXPLICIT_ALERT_RE.test(row.raw_subject.trim());
    if (!explicitAlert && isBenignNotification(row.raw_from, row.raw_subject, combined)) continue;

    const re = new RegExp(LAST4_NEAR_RE.source, "gi");
    let m: RegExpExecArray | null;
    let matched: string | null = null;
    while ((m = re.exec(combined))) {
      if (knownLast4s.has(m[1])) {
        matched = m[1];
        break;
      }
    }
    if (!matched && !explicitAlert) continue;

    out.push({
      gmail_message_id: row.gmail_message_id,
      sender: row.raw_from,
      subject: row.raw_subject,
      matched_last4: matched ?? "unknown",
      snippet: combined.slice(0, 200),
      internal_date: row.internal_date ?? null,
    });
  }
  return out;
}
