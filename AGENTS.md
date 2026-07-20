# CardIQ — Project Rules

> Project rules for CardIQ, for any agent that reads `AGENTS.md`.
>
> ⚠️ This file MIRRORS `.claude/CLAUDE.md` from `## Stack` onward. Two agents
> read the same invariants from two paths, so the bodies must never drift.
> `src/lib/project-rules-sync.test.ts` fails the suite if they do — edit BOTH
> files, or the next `npm run test` will tell you which one you forgot.

## Stack

Next.js 14 (App Router) + TypeScript + Tailwind · Supabase (Postgres + RLS + Google OAuth) · Anthropic API (chat) · Vercel hosting · Gmail read-only API.

## Invariants (break these → break the project)

1. Gmail access **must** stay read-only (`messages.list` + `messages.get`) — never request write scopes.
2. Secrets (Anthropic key, Google refresh token) **must** stay server-side, AES-256 encrypted in `user_settings` — never sent to the client.
3. Every synced transaction **must** dedupe by `gmail_message_id`; every fetched email ID **must** be recorded in `gmail_seen_messages` (success, skip, or error) so no email is ever downloaded twice.
4. Category names **must** come from `src/lib/categories.ts` — the single canonical list shared by UI and backend (ARCH-04).
5. Merchant lookup **must** stay two-pass: `raw_name` first, then `cleanMerchant(raw)` — display overrides key on cleaned names.
6. Order matching is **merchant-first**: a D2C brand's own email (with item detail) always claims a transaction before a payment-gateway (Razorpay) confirmation for the same charge. `orderMatchRank()` sorts by richness before matching, but sorting alone only holds WITHIN one sync run — across runs a poorer email can claim a charge before a richer one exists. `planDedup()` (`src/lib/order-dedup.ts`) is the reconciliation pass that fixes this retroactively (transfers a stray charge from a poorer duplicate to the richer primary); it's the single source of truth used by both the live sync and any heal script — never re-implement this logic inline (2026-07-15 fix).

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
