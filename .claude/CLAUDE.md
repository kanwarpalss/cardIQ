# CardIQ — Project Rules

> Loaded ONLY in CardIQ sessions. Stacks with global CLAUDE.md.
>
> ⚠️ Everything from `## Stack` onward is MIRRORED in `/AGENTS.md`, which a
> second LLM reads. Edit BOTH files together — `src/lib/project-rules-sync.test.ts`
> fails the suite if they drift.

## Stack

Next.js 14 (App Router) + TypeScript + Tailwind · Supabase (Postgres + RLS + Google OAuth) · Anthropic API (chat) · Vercel hosting · Gmail read-only API.

## Invariants (break these → break the project)

1. Gmail access **must** stay read-only (`messages.list` + `messages.get`) — never request write scopes.
2. Secrets (Anthropic key, Google refresh token) **must** stay server-side, AES-256 encrypted in `user_settings` — never sent to the client.
3. Every synced transaction **must** dedupe by `gmail_message_id`; every fetched email ID **must** be recorded in `gmail_seen_messages` (success, skip, or error) so no email is ever downloaded twice.
4. Category names **must** come from `src/lib/categories.ts` — the single canonical list shared by UI and backend (ARCH-04).
5. Merchant lookup **must** stay two-pass: `raw_name` first, then `cleanMerchant(raw)` — display overrides key on cleaned names.
6. Order matching is **merchant-first**: a D2C brand's own email (with item detail) always claims a transaction before a payment-gateway (Razorpay) confirmation for the same charge. `orderMatchRank()` sorts by richness before matching, but sorting alone only holds WITHIN one sync run — across runs a poorer email can claim a charge before a richer one exists. `planDedup()` (`src/lib/order-dedup.ts`) is the reconciliation pass that fixes this retroactively (transfers a stray charge from a poorer duplicate to the richer primary); it's the single source of truth used by both the live sync and any heal script — never re-implement this logic inline (2026-07-15 fix).
7. The Gyftr ledger is **evidence-backed**: issuance emails are matched as aggregate batches to one funding charge; voucher drawdowns require receipt-stated portions or a unique, affine card-plus-voucher remainder that exactly covers the order. Use `scripts/reconcile-voucher-ledger.ts` for historical repair; never restore the old same-brand/full-order heuristic or erase an existing `inferred_split` during a generic reparse (2026-07-21 fix).
8. Courier/logistics senders (Shiprocket, Delhivery, Bluedart, Ekart, etc. — see `isLogisticsSender()` in `src/lib/parsers/orders/registry.ts`) **must never** be parsed as orders. They only ever relay fulfilment status for a purchase made elsewhere; their totals/items are noise that evades dedup (courier name ≠ merchant, no shared order_ref, dated days after the real order). Reject by SENDER before any parser runs — do not try to catch this via subject-text patterns alone, since a real merchant's "delivered" receipt (Swiggy/Instamart) and a courier's "delivered" ping look identical in text (2026-07-22 fix).

## Critical files (read before modifying)

| File | Why |
|---|---|
| `src/app/api/gmail/sync/route.ts` | Sync core: cursor logic, seen-message tracking, dedup — careless edit = silent data loss or re-download storms |
| `src/lib/parsers/axis.ts` (and sibling bank parsers) | Regex parsers — a small change silently drops transactions |
| `src/lib/categorize.ts` + `src/lib/categories.ts` | Category rules + canonical list — divergence breaks UI/backend agreement |
| `src/lib/merchant-clean.ts` | Cleaned names are mapping keys — changing cleaning logic orphans existing overrides |
| `src/lib/cards/registry.ts` | Card specs (milestones, senders) — sender lists gate what the sync even sees |
| `supabase/migrations/` | Migrations run manually in order — never edit an applied migration, only add new ones |

## Deployment

- Local dev: `npm run dev` at repo root → http://localhost:3000
- Production: Vercel — auto-deploys on `git push origin main` (solo, direct-to-main)
- Env vars per SPEC §8 **must** be mirrored in Vercel project settings
- Supabase migrations run manually in the SQL Editor, in numeric order

## Test commands

- `npm run test` (vitest) — **must** pass before any commit
- `npm run typecheck` + `npm run lint` — must be clean before declaring done
- Parser changes **must** ship with a regression test that fails on the old code (TEST-01)

## Project-specific rules

- SPEC §10 says `cardiq-app/` — repo was flattened 2026-06-28; repo root IS the app. Fix SPEC when next updating it.
- Sync changes must be tested against real synced data counts (`new_txns`, `gmail_seen_messages` rows), not just code reading (TEST-02).
- "Load full history" (5-year backfill) is long-running (20–30 min) — never interrupt it, and never trigger it as a casual test.
- Amounts are money: parser/aggregation logic is boundary-prover territory (₹ formats, lakhs separators, reversals/refunds).
- Blinkit has no email/export path: its only complete source is the authenticated browser collector (`scripts/blinkit-browser-collector.ts`). The order-detail endpoint is **POST**, uses the `order_details_v2` deeplink ID format, and Blinkit 429-rate-limits concurrent detail fetches — the collector fetches serially with adaptive backoff, never in parallel. Amazon's complete source is the user's official "Request Your Information" export; the real amazon.in file is `Your Amazon Orders/Order History.csv` (NOT `Retail.OrderHistory.1.csv`, which is Amazon US's filename). Both import scripts dry-run by default; do not claim either history is complete until its real source file has been imported and audited. Amazon's CSV has a `Shipment Item Subtotal` column that repeats a per-SHIPMENT total on every item row of that shipment — never sum it as a per-item price (use `Total Amount`/`Total Owed` instead); this inflated real totals before the 2026-07-22 fix.
- After any bulk import, run `scripts/sync-orders-offline.ts` (dry-run first, `--apply` to write) to match new orders to card charges and flag same-purchase duplicates without needing a live Gmail session — it calls the same `matchOrderToTxn`/`planDedup` the live sync uses.

## Current Handoff (2026-07-22)

- **Blinkit + Amazon imports are DONE and live** (supersedes the 2026-07-21 "data-pending" state): 84 Blinkit orders (352 items, complete baskets) + 484 Amazon orders (433 new this session, all currencies). DB: 2,380 total orders, 2,110 visible / 270 duplicates hidden / 413 charge-matched.
- **Live voucher ledger is reconciled:** migration 017 is applied; 567 vouchers, 314 funding-charge links, zero malformed brands, and two fully attributed evidence-backed splits totaling ₹5,931 (IKEA and Birkenstock #525889).
- **Orders ledger cleaned:** courier/logistics senders (Shiprocket etc.) permanently rejected at parse time (Invariant #8); 13 existing phantom rows deleted (backed up first, none were charge-linked). Legit "delivered"-subject receipts (Swiggy/Instamart/one real UNIQLO order) deliberately left untouched — see `Claude HQ/summaries/cardIQ/order-item-detail-bugfix.md` §K for the full investigation.
- **Known non-bug limitation:** most of the 517 bulk-imported orders will never show a "paid on card" badge. 57% predate the bank-transaction table (earliest row 2021-05-26); ~20% were paid via UPI/wallet (amount never appears as any card debit); the rest are amount-coincidences the matcher correctly refuses to force-link. A UPI/wallet data source would be the real lever — not a matcher tolerance tweak.
- **Deployed:** commits `76ba31f` + `7e65159` + `5cc8b85` pushed to `origin/main` (Vercel auto-deploys). Verified `git rev-parse HEAD == origin/main`.
- **Next session:** no open Blinkit/Amazon work remains. If revisiting orders, start from the SPEC §9 baseline above rather than re-auditing from scratch.
