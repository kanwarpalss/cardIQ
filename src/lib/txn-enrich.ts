// Transaction enrichment — the single chokepoint that decides
// what (amount_inr, original_currency, original_amount) gets stored.
//
// Why this lives in its own file:
//   • There are FOUR write paths that insert/upsert into transactions:
//       1. /api/gmail/sync           (incremental sync)
//       2. /api/gmail/reprocess      (retry failed-parse rows)
//       3. /api/gmail/wipe-and-reingest
//       4. /api/cards/backfill       (link orphans + re-sniff stored emails)
//   • All four MUST agree on the foreign-currency conversion logic.
//     Pre-refactor they all duplicated `original_amount: parsed.amount_original ?? parsed.amount_inr`
//     which silently propagated the IDR-as-INR bug through every code path.
//   • Centralising it here means one place to fix bugs, one place to
//     historical-FX.
//
// Contract:
//   Input  : a ParsedTxn (from any parser) + the txn date + supabase client
//   Output : the exact { amount_inr, original_currency, original_amount }
//            triple to write to the transactions table.
//
// Rules (also enforced by the parsers but defended again here):
//   • currency = INR (or unset)            → amount_inr = parsed.amount_inr
//                                            original_currency = 'INR'
//                                            original_amount = amount_inr
//   • currency = foreign + Bank gave INR equiv (Axis "Indian Rupee Equivalent")
//                                          → parsed.amount_inr is already
//                                            the bank-supplied INR figure;
//                                            trust it (banks know better
//                                            than mid-market rates)
//   • currency = foreign + no INR equiv    → fetch historical rate;
//                                            amount_inr = original × rate
//                                            (or 0 if rate unavailable —
//                                            the refresh-fx endpoint will
//                                            backfill later)

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedTxn } from "./parsers/axis";
import { isInr } from "./currency";
import { getRateToInr } from "./historical-fx";

export interface EnrichedAmount {
  amount_inr: number;
  original_currency: string;
  original_amount: number;
}

/**
 * Decide the canonical (amount_inr, original_currency, original_amount)
 * triple for a parsed transaction.
 *
 * @param supabase    Supabase client (for FX cache lookups + writes)
 * @param parsed      Output from any parser
 * @param txnAt       The actual txn date (use the email's Date header
 *                    when available, NOT today's date — historical FX
 *                    depends on this being right).
 */
export async function enrichAmount(
  supabase: SupabaseClient,
  parsed: ParsedTxn,
  txnAt: Date,
): Promise<EnrichedAmount> {
  const code = (parsed.currency ?? "INR").toUpperCase();

  // ── INR txn (or untagged legacy) ────────────────────────────────────────
  if (isInr(code)) {
    return {
      amount_inr:        parsed.amount_inr,
      original_currency: "INR",
      original_amount:   parsed.amount_inr,
    };
  }

  // ── Foreign-currency txn ────────────────────────────────────────────────
  const original = parsed.amount_original ?? parsed.amount_inr;

  // Bank gave us an explicit INR equivalent (Axis foreign-currency emails
  // include "Indian Rupee Equivalent: INR X"). Parsers set parsed.amount_inr
  // to that figure when present. We detect this by: amount_inr > 0 AND
  // amount_inr != original. Trust it — banks use the rate they actually
  // booked the txn at, more accurate than mid-market.
  const bankProvidedInr = parsed.amount_inr > 0 && parsed.amount_inr !== original;
  if (bankProvidedInr) {
    return {
      amount_inr:        parsed.amount_inr,
      original_currency: code,
      original_amount:   original,
    };
  }

  // No bank-provided INR — look up historical rate. Returns null if the
  // currency is unknown to the API or the date is unreachable; caller
  // will see amount_inr=0 in that case.
  const rate = await getRateToInr(supabase, code, txnAt);
  const amount_inr = rate != null ? round2(original * rate) : 0;

  return {
    amount_inr,
    original_currency: code,
    original_amount:   original,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
