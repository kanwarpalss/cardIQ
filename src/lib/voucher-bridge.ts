// Voucher bridge (V2 feature C — best-effort reconciliation). Pure logic, no
// I/O — unit-tested in voucher-bridge.test.ts.
//
// THE PROBLEM
// ───────────
// KP often pays merchants (Amazon, Swiggy, BigBasket, Blinkit…) from a *wallet
// or voucher balance*, not directly by card. The voucher itself was bought via
// Gyftr, and THAT purchase is the real card charge. So the money chain is:
//
//     card charge (to Gyftr)  →  ₹X brand voucher  →  many merchant orders
//                                                       drawn against the ₹X
//
// The plain order↔txn matcher (order-match.ts) can never link those merchant
// orders to a card charge, because no card charge for them exists — the card
// paid Gyftr once, up front. This module rebuilds the missing middle: it draws
// each voucher-paid order down against the brand's vouchers until the voucher's
// face value is (almost) used up, so every such order can be traced back to the
// Gyftr card charge that ultimately funded it.
//
// THREE INPUTS (per KP's spec)
// ────────────
//  1. Voucher-paid merchant orders — orders whose email says they were paid
//     from a wallet/voucher (e.g. Swiggy "Paid Via Swiggy Money ₹50"). The
//     caller passes the *wallet-funded portion* as `amount` (a split order's
//     card portion is matched separately by order-match.ts).
//  2. Voucher purchases — from Gyftr emails: which brand, what face value, when,
//     and the card txn that bought it.
//  3. This engine attributes (1) to (2), FIFO by purchase date, until each
//     voucher "almost reconciles" (remaining ≈ 0).
//
// PHILOSOPHY (same as the matcher): best-effort, and honest about uncertainty.
// A voucher is never over-drawn (draws cap at its remaining balance); an order
// that can't be fully covered records a `shortfall` rather than a false link.

/** A voucher bought via Gyftr (or similar), funded by one card charge. */
export type VoucherPurchase = {
  id: string;
  /** Brand the voucher spends at — free text; normalized internally. */
  brand: string;
  /** Face value in INR: the spendable balance. NOT the (often discounted)
   *  price paid to Gyftr — the card charge amount lives with `cardTxnId`. */
  faceValue: number;
  /** ISO timestamp the voucher became usable (its purchase/issue time). */
  purchasedAt: string;
  /** The card transaction that paid Gyftr for this voucher — the chain's root. */
  cardTxnId?: string | null;
};

/** A merchant order paid (wholly or partly) from a voucher/wallet balance. */
export type VoucherPaidOrder = {
  id: string;
  /** Merchant brand — free text; normalized internally. */
  brand: string;
  /** Exact voucher family when known. This is essential for multi-brand
   * instruments such as Luxe being spent at Birkenstock. */
  voucherBrand?: string | null;
  /** The voucher/wallet-funded amount in INR (NOT any card-paid split portion). */
  amount: number;
  /** ISO timestamp of the order. */
  orderedAt: string;
};

/** One pull an order makes from one voucher. */
export type Draw = {
  voucherId: string;
  amount: number;
  /** The card txn that funded this voucher — completes order → voucher → card. */
  cardTxnId?: string | null;
};

export type AttributionStatus = "attributed" | "partial" | "unattributed";

export type OrderAttribution = {
  orderId: string;
  brand: string;
  amount: number;
  /** Vouchers this order drew from, oldest first (an order can span several). */
  draws: Draw[];
  /** Sum of `draws` — how much of the order we traced to a voucher. */
  attributed: number;
  /** amount − attributed. > 0 means no voucher balance was left to cover it. */
  shortfall: number;
  status: AttributionStatus;
};

export type VoucherState = {
  voucherId: string;
  brand: string;
  faceValue: number;
  /** Total drawn by orders. */
  drawn: number;
  /** faceValue − drawn (never negative — draws are capped). */
  remaining: number;
  /** remaining ≤ tolerance → the voucher is (almost) fully used up. */
  reconciled: boolean;
  /** Orders funded by this voucher, in draw order. */
  orderIds: string[];
};

export type BridgeResult = {
  orders: OrderAttribution[];
  vouchers: VoucherState[];
};

export type BridgeOptions = {
  /** A voucher counts as reconciled when its leftover ≤ this (₹). Default 1
   *  (covers rounding). Raise it if "almost" should be looser for you. */
  reconcileTolerance?: number;
  /** Email timestamps are fuzzy; allow a voucher bought up to this many hours
   *  AFTER an order to still fund it (absorbs clock skew). Default 24h. */
  graceHours?: number;
};

const DEFAULTS: Required<BridgeOptions> = { reconcileTolerance: 1, graceHours: 24 };

// Brand aliases → a single canonical key, so "Amazon Pay", "amazon.in" and a
// "Swiggy Money" wallet all line up with the right vouchers. Extend freely;
// unknown brands fall back to a slugified form of the raw string, so a brand
// we haven't listed still reconciles against ITS OWN vouchers (just not across
// aliases). Cross-brand funding is impossible by construction.
const BRAND_ALIASES: Record<string, string> = {
  "amazon": "amazon", "amazon pay": "amazon", "amazonpay": "amazon", "amazon.in": "amazon",
  // Gyftr sells Amazon vouchers under sub-brands ("Amazon Fresh", "Amazon
  // Shopping"). Amazon India gift balance is universal on amazon.in, so these
  // all reconcile against Amazon orders. (If a Fresh voucher is ever found to be
  // grocery-only, split this out — for now KP spends them as general Amazon.)
  "amazon fresh": "amazon", "amazonfresh": "amazon", "amazon shopping": "amazon", "amazon.in shopping": "amazon",
  "swiggy": "swiggy", "swiggy money": "swiggy", "swiggymoney": "swiggy", "swiggy.in": "swiggy",
  "zomato": "zomato",
  "bigbasket": "bigbasket", "big basket": "bigbasket", "bigbasket wallet": "bigbasket", "bbnow": "bigbasket", "bb now": "bigbasket",
  "blinkit": "blinkit", "grofers": "blinkit",
  "flipkart": "flipkart",
  "luxe": "luxe", "luxe gift card": "luxe",
  "birkenstock": "birkenstock", "birkenstock india": "birkenstock",
  "hp pay": "hppay", "hp pay wallet": "hppay",
};

// Multi-brand voucher acceptance must be explicit. Same-brand funding is
// always allowed; cross-brand funding is allowed only by this audited map.
const MERCHANT_VOUCHER_ACCEPTANCE: Record<string, string[]> = {
  birkenstock: ["luxe"],
};

/** Collapse a merchant/voucher brand string to a canonical key. */
export function normalizeBrand(raw: string): string {
  const cleaned = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (BRAND_ALIASES[cleaned]) return BRAND_ALIASES[cleaned];
  // Strip a "<brand> money/wallet/pay/voucher/gift card" suffix, then re-check.
  const stripped = cleaned.replace(/\s+(money|wallet|pay|voucher|gift ?card|balance)$/i, "").trim();
  if (BRAND_ALIASES[stripped]) return BRAND_ALIASES[stripped];
  // Unknown brand → its own slug (letters/digits only). Reconciles with its own
  // vouchers; never bleeds into another brand's balance.
  return (stripped || cleaned).replace(/[^a-z0-9]+/g, "") || "unknown";
}

export function compatibleVoucherKeys(merchant: string): string[] {
  const key = normalizeBrand(merchant);
  return [...new Set([key, ...(MERCHANT_VOUCHER_ACCEPTANCE[key] ?? [])])];
}

function ms(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * Reconcile voucher-paid orders against voucher purchases, per brand, FIFO.
 *
 * Determinism: within a brand, vouchers are consumed oldest-purchase-first and
 * orders are attributed oldest-order-first; ties broken by id so the result is
 * stable regardless of input order.
 */
export function reconcileVouchers(
  vouchers: VoucherPurchase[],
  orders: VoucherPaidOrder[],
  options: BridgeOptions = {}
): BridgeResult {
  const { reconcileTolerance, graceHours } = { ...DEFAULTS, ...options };
  const graceMs = graceHours * 3_600_000;

  // Mutable per-voucher ledger, grouped by canonical brand.
  type Ledger = VoucherPurchase & { key: string; remaining: number; orderIds: string[] };
  const byBrand = new Map<string, Ledger[]>();
  for (const v of vouchers) {
    // Guard against junk face values — a non-positive voucher can fund nothing.
    if (!(v.faceValue > 0)) continue;
    const key = normalizeBrand(v.brand);
    const led: Ledger = { ...v, key, remaining: v.faceValue, orderIds: [] };
    (byBrand.get(key) ?? byBrand.set(key, []).get(key)!).push(led);
  }
  // Oldest voucher first; stable tie-break by id.
  for (const list of byBrand.values()) {
    list.sort((a, b) => ms(a.purchasedAt) - ms(b.purchasedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // Orders oldest-first so earlier spends drain earlier vouchers.
  const sortedOrders = [...orders].sort(
    (a, b) => ms(a.orderedAt) - ms(b.orderedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );

  const attributions: OrderAttribution[] = [];
  for (const o of sortedOrders) {
    const key = normalizeBrand(o.brand);
    const draws: Draw[] = [];
    let need = o.amount > 0 ? o.amount : 0; // non-positive order → nothing to draw

    if (need > 0) {
      const allowedKeys = o.voucherBrand
        ? [normalizeBrand(o.voucherBrand)]
        : compatibleVoucherKeys(key);
      const pool = allowedKeys
        .flatMap((allowed) => byBrand.get(allowed) ?? [])
        .sort((a, b) => ms(a.purchasedAt) - ms(b.purchasedAt) || a.id.localeCompare(b.id));
      for (const v of pool) {
        if (need <= 0) break;
        // A voucher can only fund orders placed at/after it was bought
        // (+ grace for email-timestamp skew), and only while it has balance.
        if (ms(v.purchasedAt) > ms(o.orderedAt) + graceMs) continue;
        if (v.remaining <= 0) continue;
        const take = Math.min(v.remaining, need);
        v.remaining -= take;
        v.orderIds.push(o.id);
        need -= take;
        draws.push({ voucherId: v.id, amount: round2(take), cardTxnId: v.cardTxnId ?? null });
      }
    }

    const attributed = draws.reduce((s, d) => s + d.amount, 0);
    const shortfall = round2(Math.max(0, o.amount - attributed));
    const status: AttributionStatus =
      attributed <= 0 ? "unattributed" : shortfall > reconcileTolerance ? "partial" : "attributed";
    attributions.push({
      orderId: o.id, brand: key, amount: o.amount,
      draws, attributed: round2(attributed), shortfall, status,
    });
  }

  const voucherStates: VoucherState[] = [];
  for (const list of byBrand.values()) {
    for (const v of list) {
      const drawn = round2(v.faceValue - v.remaining);
      voucherStates.push({
        voucherId: v.id, brand: v.key, faceValue: v.faceValue,
        drawn, remaining: round2(v.remaining),
        reconciled: v.remaining <= reconcileTolerance,
        orderIds: v.orderIds,
      });
    }
  }

  return { orders: attributions, vouchers: voucherStates };
}

// ── Inferred-FIFO attribution (Invariant #7 v2, 2026-07-24) ──────────────────
//
// The evidence-only rule above leaves most genuinely-spent vouchers reading as
// "unused": a wallet/voucher spend (Amazon Pay balance, Swiggy Money, a Shopify
// store-credit checkout) rarely states "paid from gift card" in a parseable way,
// so no evidence candidate is ever built for it. KP accepted a best-effort layer
// (chosen over strict evidence-only) to close that gap — with two guardrails that
// keep it honest and stop it from becoming the old blunt same-brand heuristic:
//
//   1. Evidence ALWAYS wins. Inferred draws only touch balance the evidence pass
//      left behind (two passes below), so a receipt-stated draw is never
//      displaced by a guess.
//   2. Only UNMATCHED orders qualify. An order already tied to a card charge was
//      paid by that card — attributing it to a voucher too would double-count the
//      same spend. `isInferredFifoEligible` excludes anything with a txn.
//
// Inferred draws are tagged `inferred_fifo` by the caller so the UI can show
// "likely used" rather than claiming certainty it doesn't have.

/** The order fields the eligibility rule reads — shaped so the runner and the
 *  live sync feed it identically (one rule, no drift). */
export type InferredEligibleOrder = {
  kind: string;
  duplicateOf: unknown;    // truthy → a same-purchase duplicate; never attribute
  reviewStatus: unknown;   // "rejected" → KP unlinked it; respect that
  txnId: unknown;          // truthy → paid by a card charge; NOT voucher-funded
  voucherPaidAmount: unknown; // non-null → already an evidence candidate
  source: string;          // "razorpay" → gateway echo, not a real merchant order
  total: number;
  itemCount: number;       // 0 → a bare confirmation, too thin to trust
};

/**
 * Is this order a candidate for inferred-FIFO voucher attribution? A real,
 * non-duplicate, un-rejected order with item detail, a positive total, NO card
 * charge, not already evidence-attributed, and not a payment-gateway echo.
 * Brand/date gating is intentionally NOT here — reconcileVouchers only ever
 * draws a same-brand voucher bought in time, so the pool does that filtering.
 */
export function isInferredFifoEligible(o: InferredEligibleOrder): boolean {
  return (
    o.kind === "order" &&
    !o.duplicateOf &&
    o.reviewStatus !== "rejected" &&
    !o.txnId &&
    o.voucherPaidAmount == null &&
    o.source !== "razorpay" &&
    o.total > 0 &&
    o.itemCount > 0
  );
}

/**
 * Two-tier reconciliation. Evidence orders claim voucher balance first; inferred
 * orders then draw down only what's LEFT, per brand, FIFO. Returns merged order
 * attributions and final voucher states — the drawn/remaining a caller persists.
 *
 * Determinism is inherited from reconcileVouchers (oldest voucher + oldest order
 * first, id tie-break), so the same inputs always yield the same ledger.
 */
export function reconcileWithInferred(
  vouchers: VoucherPurchase[],
  evidenceOrders: VoucherPaidOrder[],
  inferredOrders: VoucherPaidOrder[],
  options: BridgeOptions = {}
): BridgeResult {
  const tolerance = options.reconcileTolerance ?? DEFAULTS.reconcileTolerance;

  // Pass 1 — evidence. Authoritative; it drains balance before any guess runs.
  const pass1 = reconcileVouchers(vouchers, evidenceOrders, options);

  // Pass 2 — inferred, against the leftover balance. Residual vouchers keep the
  // SAME id/brand/date/card so FIFO semantics carry across (a voucher half-used
  // by evidence offers only its remainder to inferred orders).
  const remainingById = new Map(pass1.vouchers.map((v) => [v.voucherId, v.remaining]));
  const residual: VoucherPurchase[] = vouchers.map((v) => ({
    ...v,
    faceValue: remainingById.has(v.id) ? remainingById.get(v.id)! : v.faceValue,
  }));
  const pass2 = reconcileVouchers(residual, inferredOrders, options);

  // Merge voucher states: total drawn = evidence + inferred; remaining is pass 2's
  // (it worked off pass 1's leftover); orderIds concatenated in draw order.
  const merged = new Map<string, VoucherState>();
  for (const v of pass1.vouchers) merged.set(v.voucherId, { ...v });
  for (const v of pass2.vouchers) {
    const prev = merged.get(v.voucherId);
    if (!prev) { merged.set(v.voucherId, v); continue; }
    const drawn = round2(prev.drawn + v.drawn);
    merged.set(v.voucherId, {
      voucherId: v.voucherId,
      brand: v.brand,
      faceValue: prev.faceValue,
      drawn,
      remaining: v.remaining,
      reconciled: v.remaining <= tolerance,
      orderIds: [...prev.orderIds, ...v.orderIds],
    });
  }

  // Each order is in exactly one pass (evidence and inferred sets are disjoint by
  // construction — an evidence order has voucherPaidAmount != null, which
  // isInferredFifoEligible excludes).
  return { orders: [...pass1.orders, ...pass2.orders], vouchers: [...merged.values()] };
}

/** Money rounding: keep paise but kill float dust (0.1+0.2 style drift). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
