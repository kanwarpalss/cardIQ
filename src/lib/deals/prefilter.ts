// The free first pass: decide from a subject line (and sender / preview) alone
// whether an email or blog post is worth sending to the AI reader.
//
// KP's inbox, Jul–Nov 2026: 32 "bonus points" emails, only ~8 real deals.
// The rest were per-stay promos, KrisShop/Pelago spend offers and app
// points. This pass throws those away for free. It errs towards letting
// things through — a wrongly-passed item costs a fraction of a paisa at the
// AI step, which then says "not a deal"; a wrongly-dropped one is a missed
// 50% Accor transfer bonus.

import { matchProgram } from "@/lib/transfer-partners/math";
import type { ProgramKey } from "@/lib/transfer-partners/programs";
import type { BankKey } from "./types";

export type Candidate = { from: string; subject: string; snippet?: string };

export type Screen =
  | { pass: true; signal: "buy" | "transfer" | "ratio" | "percent"; program: ProgramKey | null; bank: BankKey | null }
  | { pass: false; reason: string };

// Whole-word patterns for KP's banks. "SmartBuy" and "EDGE" are the banks'
// own reward-portal names, which their promo emails often lead with.
const BANK_PATTERNS: [BankKey, RegExp][] = [
  ["axis", /\baxis(?:bank)?\b|\bedge (?:rewards?|miles)\b/],
  ["hdfc", /\bhdfc(?:bank)?\b|\bsmartbuy\b|\binfinia\b/],
  ["hsbc", /\bhsbc\b|\btravelone\b/],
  ["icici", /\bicici(?:bank)?\b|\bemeralde\b/],
  ["amex", /\bamex\b|\bamerican ?express\b|\bmembership rewards\b/],
];

/** First of KP's banks named in the text, or null. */
export function matchBank(text: string): BankKey | null {
  const t = text.toLowerCase();
  for (const [key, re] of BANK_PATTERNS) if (re.test(t)) return key;
  return null;
}

/** Map a CARD_REGISTRY issuer ("HDFC Bank", "American Express") to a BankKey. */
export function bankOfIssuer(issuer: string): BankKey | null {
  return matchBank(issuer);
}

const CURRENCY = String.raw`(?:points?|miles|avios|bluchips?)`;

// Buying points: "Buy Points Before…", "buy or gift points", "Buy Finnair Plus
// Avios with a 50% Discount", Marriott's "Get Your Bonus Points Offer Now".
const BUY = new RegExp(
  String.raw`\b(?:buy|buying|purchase|gift)\b[^.!?]{0,40}\b${CURRENCY}\b|\bbonus points offer\b|\bpoints? sale\b`,
);
// Transfers with a bonus or changed ratio: "convert … 50% bonus", "Transfer
// Bonus", "Conversion Bonus", "10% Bonus on … Miles to Points".
const TRANSFER_WORD = /\b(?:transfer\w*|convert\w*|conversion)\b|\bmiles to points\b|\bpoints to miles\b/;
const TRANSFER_BONUS = /\bbonus\b|\d\s?%|\bextra\b/;
// Lasting partner/ratio changes: "Improved Transfers to …", "adds Accor as
// Points Transfer Partner", "devaluation".
const RATIO = /\bimproved transfers?\b|\btransfer (?:ratio|partner)s?\b|\bdevaluat\w*|\btransfer rates?\b/;
// "50% bonus", "up to 55% bonus points", "50% discount", "25% off".
const PERCENT = /\d{1,3}\s?%\s*(?:bonus|off|discount|more)\b/;
// Earning promos that look like deals but aren't about buying or moving
// points. Only consulted when the sole signal is a bare percentage.
const NOISE = /\bper (?:stay|night|s?\$|usd|sgd)|\bstays?\b|\bkrisshop\b|\bpelago\b|\bmpd\b|\bsign-?up bonus\b|\bwelcome bonus\b|\bstatus match\b|\baward(?:s| chart)?\b|\bfares?\b|\bflight sale\b|\bdining\b|\bshop(?:ping)?\b/;

export function screen(c: Candidate): Screen {
  const text = `${c.subject} ${c.snippet ?? ""}`.toLowerCase().replace(/\s+/g, " ");
  const program = matchProgram(`${c.from} ${text}`);
  const bank = matchBank(`${c.from} ${text}`);

  let signal: "buy" | "transfer" | "ratio" | "percent" | null = null;
  if (BUY.test(text)) signal = "buy";
  else if (TRANSFER_WORD.test(text) && TRANSFER_BONUS.test(text)) signal = "transfer";
  else if (RATIO.test(text)) signal = "ratio";
  else if (PERCENT.test(text) && !NOISE.test(text)) signal = "percent";

  if (!signal) {
    return { pass: false, reason: NOISE.test(text) ? "earning promo, not a points deal" : "no buy/transfer/bonus signal" };
  }
  // A deal must be about something KP could act on: a catalog program or one
  // of his banks. "11.11 sale on CheQ Points" names neither.
  if (!program && !bank) return { pass: false, reason: "no known program or bank named" };
  return { pass: true, signal, program, bank };
}

/**
 * The Gmail search the daily job runs (works verbatim over IMAP X-GM-RAW).
 * Deliberately broad — screen() does the real narrowing on subject lines,
 * which IMAP hands back with the search for free.
 */
export function dealSearchQuery(afterEpochSec: number): string {
  return [
    `after:${Math.floor(afterEpochSec)}`,
    "-category:social",
    "{bonus transfer convert conversion buy discount sale}",
    "{points miles avios}",
  ].join(" ");
}
