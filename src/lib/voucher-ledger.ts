// Voucher ledger summary (V2 feature C — the Vouchers view).
//
// A Gyftr voucher has a face value (spendable balance). Merchant orders paid
// from that balance are recorded on `orders.voucher_draws` — each draw pulls
// `amount` from one `voucherId` (voucher-bridge.ts / order-dedup.ts write them).
//
// This module answers the plain-English question the Vouchers tab exists to
// show: "for each voucher I bought, how much have I spent, and how much is
// left?" It is pure (no I/O) so it can be unit-tested with cruel inputs — the
// API route (/api/vouchers) feeds it rows from the DB and renders the result.

/** A voucher purchase — only the fields the ledger math needs. */
export type LedgerVoucher = {
  id: string;
  faceValue: number;
};

/** One pull an order made from a voucher (as stored in orders.voucher_draws). */
export type LedgerDraw = {
  voucherId: string;
  amount: number;
  /** How sure we are of this draw: "manual" (KP verified) / "email" /
   *  "inferred_split" are evidence; "inferred_fifo" is a best-effort guess.
   *  Threaded through so the UI can mark a guessed drawdown "likely". */
  evidence?: string;
};

/** An order that drew from one or more vouchers. */
export type LedgerOrder = {
  id: string;
  /** Best merchant label for the "spent at" line; falls back to source. */
  merchant: string;
  orderAt: string;
  draws: LedgerDraw[];
};

/** Where one voucher's balance went — the drawdown detail for the expand row. */
export type LedgerSpend = {
  orderId: string;
  merchant: string;
  amount: number;
  orderAt: string;
  /** Confidence of this spend (see LedgerDraw.evidence). Absent = legacy draw. */
  evidence?: string;
};

/** Per-voucher spend summary. `remaining` is always clamped to [0, faceValue]:
 *  draws never over-spend a voucher (the bridge caps them), but a stray refund
 *  or duplicate draw must never make a voucher read as "more than full" or
 *  "negative left" — the balance a human sees stays sane no matter the data. */
export type VoucherSummary = {
  drawn: number;
  remaining: number;
  spends: LedgerSpend[];
};

/** Money rounding: keep paise, kill float dust (0.1 + 0.2 drift). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Summarize every voucher's drawdown from the orders that spent it.
 *
 * Returns a map keyed by voucher id. Every input voucher appears (an untouched
 * voucher reads drawn 0 / remaining = faceValue). Draws that reference a
 * voucher id not in `vouchers` are ignored — they can't affect a balance we
 * aren't showing, and silently carrying them would misreport totals.
 */
export function summarizeVoucherLedger(
  vouchers: LedgerVoucher[],
  orders: LedgerOrder[]
): Map<string, VoucherSummary> {
  const byId = new Map<string, VoucherSummary>();
  const faceById = new Map<string, number>();
  for (const v of vouchers) {
    faceById.set(v.id, v.faceValue);
    // Last write wins on a duplicate id — but keep an existing accumulator so
    // draws already gathered aren't dropped (order of inputs is not our call).
    if (!byId.has(v.id)) byId.set(v.id, { drawn: 0, remaining: 0, spends: [] });
  }

  for (const o of orders) {
    for (const d of o.draws ?? []) {
      const summary = byId.get(d.voucherId);
      if (!summary) continue; // draw points at a voucher we don't have — skip
      const amt = Number(d.amount);
      if (!Number.isFinite(amt) || amt === 0) continue;
      summary.drawn += amt;
      const spend: LedgerSpend = { orderId: o.id, merchant: o.merchant, amount: round2(amt), orderAt: o.orderAt };
      // Only carry evidence when present — a legacy draw without it stays a bare
      // spend (keeps toEqual assertions on old fixtures exact).
      if (d.evidence != null) spend.evidence = d.evidence;
      summary.spends.push(spend);
    }
  }

  for (const [id, summary] of byId) {
    const face = faceById.get(id) ?? 0;
    summary.drawn = round2(summary.drawn);
    // Clamp so the visible balance is always sensible: never below 0, never
    // above the voucher's own face value.
    summary.remaining = round2(Math.min(face, Math.max(0, face - summary.drawn)));
    // Spends oldest-first — the order they drew the balance down in.
    summary.spends.sort((a, b) => new Date(a.orderAt).getTime() - new Date(b.orderAt).getTime());
  }

  return byId;
}
