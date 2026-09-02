import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isMissingColumnError, isCheckViolation } from "@/lib/supabase/errors";

// POST /api/orders/payment — record a HUMAN-CONFIRMED payment split for one order
// (V2 feature C, the voucher-verification layer, 2026-07-26).
//
// The merchant email usually can't tell us how an order was paid (Pure Home's
// receipt shows no payment method at all). KP knows — he can read his voucher
// purchases + card statement and say, e.g., "₹7,249.60 from Gyftr vouchers,
// ₹182.40 on the card." This route stores that as `payment_evidence = "manual"`,
// the TOP evidence tier: the reconcile never overwrites it, never displaces it
// with a guess, and draws its vouchers down first (Invariant #7).
//
// Body: { id, voucherPaidAmount, cardPaidAmount, voucherBrandKey?, totalAmount? }
//   • voucherPaidAmount / cardPaidAmount — ₹ portions (either may be 0/null).
//   • voucherBrandKey — which voucher family funded it; defaults (in the
//     reconcile) to the order's own merchant brand when omitted.
//   • totalAmount — optional correction; only written when provided.
// Both portions 0/null → CLEARS the manual mark (re-opens the order to
// auto-inference).
//
// The actual voucher_draws (which specific voucher ids, how the balance moves)
// are computed by the reconcile / live sync — the single source of that math
// (never re-implemented here). This route records the ground truth; the ledger
// catches up on the next reconcile or Gmail sync.

const MIGRATION_017 =
  "Run supabase/migrations/017_split_voucher_payments.sql in the Supabase SQL Editor to add the payment-split columns.";
const MIGRATION_018 =
  "Run supabase/migrations/018_manual_payment_evidence.sql in the Supabase SQL Editor to allow human-verified ('manual') payments.";

/** A finite, non-negative money value, or null. Rejects NaN/Infinity/negatives. */
function money(v: unknown): number | null | undefined {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return undefined; // undefined = invalid
  return Math.round(n * 100) / 100;
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const id = body?.id;
  if (typeof id !== "string" || !id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const voucher = money(body?.voucherPaidAmount);
  const card = money(body?.cardPaidAmount);
  if (voucher === undefined || card === undefined) {
    return NextResponse.json({ error: "amounts must be non-negative numbers" }, { status: 400 });
  }
  const total = body?.totalAmount === undefined ? undefined : money(body?.totalAmount);
  if (total === undefined && body?.totalAmount !== undefined) {
    return NextResponse.json({ error: "totalAmount must be a non-negative number" }, { status: 400 });
  }
  const voucherBrandKey =
    typeof body?.voucherBrandKey === "string" && body.voucherBrandKey.trim()
      ? body.voucherBrandKey.trim().toLowerCase()
      : null;

  // Both portions empty → clear the manual mark and hand the order back to
  // auto-inference (evidence null, portions null). Otherwise stamp "manual".
  const clearing = (voucher ?? 0) <= 0 && (card ?? 0) <= 0;

  const updates: Record<string, unknown> = clearing
    ? {
        payment_evidence: null,
        voucher_paid_amount: null,
        card_paid_amount: null,
        voucher_brand_key: null,
      }
    : {
        payment_evidence: "manual",
        voucher_paid_amount: (voucher ?? 0) > 0 ? voucher : null,
        card_paid_amount: (card ?? 0) > 0 ? card : null,
        voucher_brand_key: (voucher ?? 0) > 0 ? voucherBrandKey : null,
      };
  if (total != null && total > 0) updates.total_amount = total;

  // A verification supersedes any prior auto-match: clear the link + its draws so
  // the reconcile re-derives the card-portion match and the voucher drawdown
  // from the freshly-stated truth. (Cleared draws are rebuilt on next reconcile.)
  updates.txn_id = null;
  updates.match_confidence = null;
  updates.matched_at = null;
  updates.review_status = clearing ? "unmatched" : "confirmed";
  updates.voucher_draws = [];

  const { data, error } = await supabase
    .from("orders")
    .update(updates)
    .eq("id", id)
    .eq("user_id", user.id)
    .select("id, total_amount, card_paid_amount, voucher_paid_amount, voucher_brand_key, payment_evidence")
    .maybeSingle();

  if (error) {
    const missing = ["payment_evidence", "voucher_paid_amount", "card_paid_amount", "voucher_brand_key"]
      .find((c) => isMissingColumnError(error, c));
    if (missing) return NextResponse.json({ error: "missing_payment_columns", message: MIGRATION_017 }, { status: 400 });
    // 'manual' rejected by the 017 CHECK → migration 018 not run yet.
    if (isCheckViolation(error, "orders_payment_evidence_check")) {
      return NextResponse.json({ error: "manual_evidence_not_enabled", message: MIGRATION_018 }, { status: 400 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: "order not found" }, { status: 404 });

  return NextResponse.json({ ok: true, order: data });
}
