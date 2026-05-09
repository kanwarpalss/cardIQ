import { parseAxisTxn, type ParsedTxn } from "./axis";
import { parseHdfcTxn } from "./hdfc";
import { parseIciciTxn } from "./icici";
import { parseHsbcTxn } from "./hsbc";
import { genericSniff, type GenericParsed } from "./generic-sniffer";

export type { ParsedTxn, GenericParsed };

// Maps each known sender domain to its parser
const SENDER_PARSERS: Array<{
  match: (sender: string) => boolean;
  parse: (subject: string, body: string, snippet: string) => ParsedTxn | null;
}> = [
  {
    match: (s) => s.includes("axisbank.com") || s.includes("axis.bank.in"),
    parse: parseAxisTxn,
  },
  {
    // hdfcbank.bank.in is the new (2025+) alerts domain.
    match: (s) => s.includes("hdfcbank.net") || s.includes("hdfcbank.com") || s.includes("hdfcbank.bank.in"),
    parse: parseHdfcTxn,
  },
  {
    match: (s) => s.includes("icicibank.com"),
    parse: parseIciciTxn,
  },
  {
    match: (s) => s.includes("hsbc.co.in") || s.includes("mail.hsbc"),
    parse: parseHsbcTxn,
  },
];

// Try all parsers in order — used when sender is unknown (e.g. recategorize from stored raw_body)
export function tryAllParsers(subject: string, body: string, snippet = ""): ParsedTxn | null {
  for (const { parse } of SENDER_PARSERS) {
    const result = parse(subject, body, snippet);
    if (result) return result;
  }
  return null;
}

export function parseTxnEmail(
  sender: string,
  subject: string,
  body: string,
  snippet: string = ""
): ParsedTxn | null {
  const lower = sender.toLowerCase();
  for (const { match, parse } of SENDER_PARSERS) {
    if (match(lower)) return parse(subject, body, snippet);
  }
  return null;
}

/**
 * Belt-and-suspenders: try the sender-specific parser first; if it returns
 * null, fall back to the generic sniffer using the user's known card last4s.
 *
 * Returns the result PLUS a flag indicating which path matched. Callers can
 * use the flag to mark low-confidence rows for review.
 *
 * Example use in sync route:
 *   const out = parseTxnEmailWithFallback(from, subject, body, snippet, knownLast4s);
 *   if (out) {
 *     if (out.low_confidence) await markForReview(msgId, out);
 *     else await insertTxn(out);
 *   }
 */
export function parseTxnEmailWithFallback(
  sender: string,
  subject: string,
  body: string,
  snippet: string,
  knownLast4s: Set<string>,
): (ParsedTxn & { low_confidence?: boolean }) | null {
  const strict = parseTxnEmail(sender, subject, body, snippet);
  if (strict) return strict;
  return genericSniff(subject, body, snippet, knownLast4s);
}
