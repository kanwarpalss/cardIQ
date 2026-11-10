# cardIQ — Project Rules

> Project rules for cardIQ, for any agent that reads `AGENTS.md`.
>
> ⚠️ This file MIRRORS `.claude/CLAUDE.md` from `## Stack` onward. Two agents
> read the same invariants from two paths, so the bodies must never drift.
> `src/lib/project-rules-sync.test.ts` fails the suite if they do — edit BOTH
> files, or the next `npm run test` will tell you which one you forgot.

## Stack

Next.js 16.3.4 (App Router) + React 19.2.8 + TypeScript + Tailwind · Supabase (Postgres + RLS + Google OAuth) · Anthropic API (chat) · Vercel hosting · Gmail read-only API.

## Invariants (break these → break the project)

1. Gmail access **must** stay read-only (`messages.list` + `messages.get`) — never request write scopes.
2. Secrets (Anthropic key, Google refresh token) **must** stay server-side, AES-256 encrypted in `user_settings` — never sent to the client.
3. Every synced transaction **must** dedupe by `gmail_message_id`; every fetched email ID **must** be recorded in `gmail_seen_messages` (success, skip, or error) so no email is ever downloaded twice.
4. Category names **must** come from `src/lib/categories.ts` — the single canonical list shared by UI and backend (ARCH-04).
5. Merchant lookup **must** stay two-pass: `raw_name` first, then `cleanMerchant(raw)` — display overrides key on cleaned names.
6. Order matching is **merchant-first**: a D2C brand's own email (with item detail) always claims a transaction before a payment-gateway (Razorpay) confirmation for the same charge. `orderMatchRank()` sorts by richness before matching, but sorting alone only holds WITHIN one sync run — across runs a poorer email can claim a charge before a richer one exists. `planDedup()` (`src/lib/order-dedup.ts`) is the reconciliation pass that fixes this retroactively (transfers a stray charge from a poorer duplicate to the richer primary); it's the single source of truth used by both the live sync and any heal script — never re-implement this logic inline (2026-07-15 fix).
7. The Gyftr ledger is **evidence-first, then best-effort**: issuance emails are matched as aggregate batches to one funding charge. Drawdowns run two tiers via `reconcileWithInferred()` — (a) EVIDENCE (receipt-stated portions, or a unique affine card-plus-voucher remainder that covers the order) always claims voucher balance first; (b) an INFERRED-FIFO layer then draws the *remaining* balance down, oldest-first, against UNMATCHED same-brand orders placed after the voucher purchase (`isInferredFifoEligible`), tagged `evidence:"inferred_fifo"` inside `voucher_draws` so the UI can show "likely" vs "confirmed". Hard rules: a card-matched order is NEVER voucher-attributed (that double-counts the card spend); evidence is never displaced by a guess; never erase an existing `inferred_split`/`inferred_fifo` during a generic reparse. Use `scripts/reconcile-voucher-ledger.ts` for historical repair (2026-07-25 hybrid model, per KP, superseding the 2026-07-21 evidence-only rule).
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

- Local dev: `npm run dev` at repo root → http://localhost:3901. The command refuses to start if another app owns cardIQ's dedicated port.
- Production: Vercel — auto-deploys on `git push origin main` (solo, direct-to-main)
- Env vars per SPEC §8 **must** be mirrored in Vercel project settings
- Supabase migrations run manually in the SQL Editor, in numeric order

## Test commands

- `npm run test` (vitest) — **must** pass before any commit
- `npm run typecheck` + `npm run lint` — must be clean before declaring done
- Parser changes **must** ship with a regression test that fails on the old code (TEST-01)

## Project-specific rules

- Sync changes must be tested against real synced data counts (`new_txns`, `gmail_seen_messages` rows), not just code reading (TEST-02).
- "Load full history" (5-year backfill) is long-running (20–30 min) — never interrupt it, and never trigger it as a casual test.
- Amounts are money: parser/aggregation logic is boundary-prover territory (₹ formats, lakhs separators, reversals/refunds).
- Blinkit has no email/export path: its only complete source is the authenticated browser collector (`scripts/blinkit-browser-collector.ts`). The order-detail endpoint is **POST**, uses the `order_details_v2` deeplink ID format, and Blinkit 429-rate-limits concurrent detail fetches — the collector fetches serially with adaptive backoff, never in parallel. Amazon's complete source is the user's official "Request Your Information" export; the real amazon.in file is `Your Amazon Orders/Order History.csv` (NOT `Retail.OrderHistory.1.csv`, which is Amazon US's filename). Both import scripts dry-run by default; do not claim either history is complete until its real source file has been imported and audited. Amazon's CSV has a `Shipment Item Subtotal` column that repeats a per-SHIPMENT total on every item row of that shipment — never sum it as a per-item price (use `Total Amount`/`Total Owed` instead); this inflated real totals before the 2026-07-22 fix.
- Sender lists gate what the sync fetches, and `gmail_seen_messages` only holds what it fetched, so a bank moving to a new address is invisible to anything reading that table (HSBC, 2026). `GET /api/gmail/format-watch` therefore also searches the mailbox itself (`src/lib/gmail/mailbox-watch.ts`) and checks for quiet cards and transactions with no card. When a bank's sender changes, add it to that card's `gmail.senders`. When format-watch's rules change, update the baseline in the weekly "cardIQ weekly format-watch check" routine, or it will compare against a stale count.
- A parser result with no 4-digit card is refused centrally in `parseTxnEmail`: a row with no card shows under no card in any tab. Never default a card number to `""`.
- Card statements are an audit source, not a sync: `scripts/statements-*.ts` read PDFs from Gmail into `~/.cardiq-statements` (never the repo). Only statements that balance against their own printed totals may add rows, only purchases and refunds are added, and every added row's `gmail_message_id` starts `stmt:`. KP unlocks PDFs himself with `statements-unlock.ts`; never type, derive or store a statement password. A wipe deletes `stmt:` rows: re-run `statements-reconcile.ts --apply` after one. Rows a balanced statement proves were never charged (second copies, released holds, declined or receipt-only rows) are removed only by `statements-reconcile.ts --remove-unbilled --apply`, which backs them up and records their emails in `excluded_messages` (migration 023) first. Every path that turns an email into a transaction must skip those IDs (`loadExcludedMessageIds`; `src/lib/excluded-messages-wiring.test.ts` fails the suite otherwise), or reprocess/backfill/wipe re-creates them.
- After any bulk import, run `scripts/sync-orders-offline.ts` (dry-run first, `--apply` to write) to match new orders to card charges and flag same-purchase duplicates without needing a live Gmail session — it calls the same `matchOrderToTxn`/`planDedup` the live sync uses.
- To check the deal finder, run `npm run deals:status` (read-only: stored deals, `deal_runs`, `deal_seen_items` by outcome, the Deals screen's health line and ranked live list; `--help` for section flags) and `npm run deals:status -- --mini` for the PM2 `cardiq-deals` settings on the Mac mini. Never write a throwaway `.probe.ts` or pipe `pm2 jlist` into inline code for this; extend `scripts/deals-status.ts` / `src/lib/deals/status.ts` instead.

## Current Handoff

**The handoff lives in `SPEC.md` §9, not here.** Two rolling logs for one fact
drift the moment either is edited, and this copy had already gone stale by a
month (global CLAUDE.md §8: SPEC.md is the single living source of truth; never
keep a parallel rolling log). Read SPEC.md §9 "Start Here — Current, Verified
State" for what is true right now, and §6 for how it got that way.

<!-- BEGIN:hq-continuity — generated block, do not hand-edit.
     Source: AI HQ/System/project-claude-template.md
     Propagate: python3 ~/"AI HQ/System/bin/sync-project-rules" -->

## Continuity — if your session dies mid-task

KP runs several agents (Claude, Codex, ChatGPT, Grok) and **credits expire
mid-task**. This section is here because you may be an agent that never reads
KP's global rulebook — do not assume someone else is handling continuity.

**Before you start**, check whether a previous session was cut off:

```bash
python3 ~/"AI HQ/System/bin/resume"          # add --json if you parse it
```

Exit 3 means nothing to resume. Otherwise it prints what the last agent was
doing, what it had landed, what failed, and what not to redo. **Report that to
KP and wait** — do not silently continue someone else's plan.

**While you work**, leave a trail so the next agent can pick up from any
instant. Claude Code does this automatically via hooks; **every other agent
must do it by hand**:

```bash
FR=~/"AI HQ/System/flight-recorder.py"
python3 "$FR" --session "<your-session-id>" --cwd "$PWD" --prompt "<what KP asked>"
python3 "$FR" --session "<your-session-id>" --note "Edit ok path/to/file.ts"
python3 "$FR" --session "<your-session-id>" --note "Bash FAIL npm run build"
python3 "$FR" --session "<your-session-id>" --intent "next=<the very next step>"
python3 "$FR" --session "<your-session-id>" --close   # only on a clean finish
```

Update `--intent` every ~15 meaningful actions, and always before a risky or
long-running step. A journal with no `--close` is what marks the session as
interrupted, so **never close a session you did not actually finish**.

**Durability:** the journal is ephemeral (14 days) and is for handoff only.
Anything worth keeping goes in `SPEC.md` §9 at session end — git and SPEC.md
are the permanent record, the journal is not.

<!-- END:hq-continuity -->

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
