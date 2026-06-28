# CardIQ — SPEC

> Project brain. Updated every session.
> Static architecture doc lives in ARCHITECTURE.md — don't duplicate it here.
> Last updated: 2026-05-07

---

## §1 What This Is

A personal credit-card intelligence app: syncs Axis Bank transaction emails from Gmail, parses + categorizes them, and provides a spend dashboard + AI chat. Hosted on Vercel (Next.js), database on Supabase (Postgres + Auth), Gmail access via Google OAuth.

## §2 Stack

| Layer | Tech |
|---|---|
| Frontend + API routes | Next.js 14, React, Tailwind |
| Database + Auth | Supabase (Postgres + RLS + Google OAuth) |
| AI chat | Anthropic Claude API |
| Hosting | Vercel |
| Gmail | Google API (messages.list + messages.get, read-only) |

## §3 Key Files

| File | Purpose |
|---|---|
| `src/app/api/gmail/sync/route.ts` | Gmail sync — fetch + parse + upsert |
| `src/app/api/merchant-mappings/route.ts` | Rename merchant / change category (bulk) |
| `src/app/api/transactions/[id]/route.ts` | PATCH single transaction category |
| `src/app/api/transactions/all/route.ts` | Fetch all transactions for client-side filtering |
| `src/app/api/recategorize/route.ts` | Re-run categorization on all stored transactions |
| `src/components/SpendTab.tsx` | Main spend dashboard UI |
| `src/components/MerchantPanel.tsx` | By-merchant panel with inline name + category editing |
| `src/lib/categorize.ts` | Keyword-based category rules |
| `src/lib/categories.ts` | Canonical category list (shared by UI and backend) |
| `src/lib/merchant-clean.ts` | Raw merchant name → cleaned display name |
| `src/lib/parsers/axis.ts` | Regex parser for Axis Bank email alerts |
| `src/lib/cards/registry.ts` | Hardcoded card specs (milestones, lounge access, senders) |
| `supabase/migrations/` | SQL migration files (run in order) |

## §4 Database Tables

- `user_settings` — encrypted Anthropic key, Google refresh token, last_gmail_sync_at
- `cards` — one row per physical card (product_key, last4, nickname)
- `transactions` — parsed transactions (merchant, category, amount, txn_at, gmail_message_id)
- `merchant_mappings` — user overrides: raw_name → normalized_name + category
- `kb_entries` — cached LLM card-topic summaries
- `chat_messages` — chat history

## §5 Decisions Log

| Date | Decision | Rejected alternative | Why |
|---|---|---|---|
| 2026-05-07 | Merchant lookup uses two-pass: raw_name first, then cleanMerchant(raw) | Single-pass raw only | Display overrides saved via UI use cleaned name as key; raw fallback ensures future syncs still respect them |
| 2026-05-07 | Inline merchant edit updates ALL transactions with that name | Prompt "apply to all?" | Less friction; bulk rename is always the right UX for merchant overrides |
| 2026-05-07 | Extracted MerchantPanel to separate component | Keep in SpendTab | SpendTab was approaching 600-line limit; edit state belongs close to the panel it controls |

## §6 Current State (as of 2026-05-09)

**Working:**
- Gmail sync (multi-bank: Axis, HDFC, ICICI, HSBC): parse → categorize → upsert (dedup by gmail_message_id)
- Incremental cursor-based sync (`gmail_sync_state.last_internal_date`)
- Domain-level sender matching (Axis: axisbank.com, axis.bank.in; HDFC: hdfcbank.net, hdfcbank.com; ICICI: icicibank.com; HSBC: hsbc.co.in, mail.hsbc.co.in) — catches all historical sender formats
- Spend tab: filters, date presets, by-merchant, by-category, milestone bars
- Inline merchant renaming + category editing (from merchant panel and transactions table)
- 5-year historical backfill via "Load full history" button (passes `lookback_days: 1825`)
- Sortable transactions table with sort indicators on all columns
- Amount-range filter (Min ₹ / Max ₹) + merchant search in transactions table
- Card NICKNAME (not last4) shown in table; falls back to last4 if no nickname
- Custom categories from "Other" inputs are persisted and re-surfaced in the dropdown next time
- Per-transaction NOTES with autofill suggestions (3+ chars; matches startsWith / word-start / contains)
- Accurate `new_txns` counter in sync results
- Re-categorize button: re-runs category rules on all stored transactions
- Chat tab: Claude API with card + profile context
- `gmail_seen_messages` table: tracks ALL fetched email IDs (success, skip, error) so no email is ever re-downloaded twice (ARCH-12 / PROC-13 compliance)

**Pending / In Flight:**
- First "Load full history" run must complete end-to-end (20–30 min for 8,382 emails) to populate `gmail_seen_messages`. Until complete, subsequent "Load full history" clicks will still re-fetch non-transactional emails. Interrupting the run wastes all progress.
- Error logging added to `flushSeenBatch()` — if writes fail, sync result UI will show CRITICAL error.

## §7 Known Issues

| Issue | Status | Notes |
|---|---|---|
| ⛔ **gmail_seen_messages not populating** | 🔴 CRITICAL — blocking sync | First "Load full history" run is in progress (2026-05-09). Must complete end-to-end (20–30 min for 8,382 emails). If table is still empty after completion, check sync result UI for CRITICAL error from flushSeenBatch(). Root cause: either (a) writes are silently failing in Supabase, or (b) run was interrupted before final flush. Commit a4f315c added error logging. Next session: query gmail_seen_messages table directly to confirm population. |
| ⛔ **Model routing hook missing** | 🔴 CRITICAL — false safety claim | CLAUDE.md §13 claims "Structurally enforced by model-routing-gate.py" but file does NOT exist at `~/.claude/model-routing-gate.py`. This is a documentation-reality mismatch. Options: (1) Build the hook to auto-inject ⚡ flags when routing keywords detected, or (2) Remove the false claim and rewrite §13 as manual guidance only. Next session: decide and fix. |
| Recategorize re-cooks ALL transactions | Pending fix | Should only re-cook transactions affected by changed mappings/rules. |
| No `raw_merchant` stored in transactions | Accepted for now | merchant_mappings uses cleaned name as raw_name key; two-pass lookup compensates. |

## §8 Environment Variables

| Variable | Where needed |
|---|---|
| `SUPABASE_URL` | Server + client |
| `NEXT_PUBLIC_SUPABASE_URL` | Client |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Client |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only |
| `GOOGLE_CLIENT_ID` | Server |
| `GOOGLE_CLIENT_SECRET` | Server |
| `ENCRYPTION_KEY` | Server (AES-256 for stored secrets) |

## §9 Session Handoff Notes (2026-05-09)

### Accomplished This Session
1. **Broadened Gmail sender matching to domain-level** (Axis, HDFC, ICICI, HSBC) — catches all historical sender formats across 5 years. Commits c44c5a2, ef9908f.
2. **Designed and implemented gmail_seen_messages table + logic** — tracks ALL fetched email IDs (success, skip, error), prevents re-downloading non-transactional emails. ARCH-12 / PROC-13 compliance. Commit ef9908f, a4f315c (error logging).
3. **Elevated critical buried rules in Claude HQ** — ⛔ Hard Rule on learnings genericity to top of README, PROC-15 pinned in Top 10 of INDEX, PROC-13 sharpened.
4. **Captured learnings to brain** — ARCH-12 (3-layer fetch design), PROC-13 (filter before fetch), PROC-15 (learnings quality gate). All three now unmissable in INDEX.

### 🔴 CRITICAL BLOCKERS — Start next session here
1. **gmail_seen_messages population STUCK** — First "Load full history" run is in progress (2026-05-09 ~21:30). Must complete without interruption (20–30 min). If table still empty after: (a) query it directly in Supabase, (b) check sync result UI for CRITICAL error message, (c) if error: investigate Supabase RLS permissions on gmail_seen_messages. Commit a4f315c added error logging to surface write failures.
2. **Model routing hook missing** — CLAUDE.md §13 claims "structurally enforced" but file doesn't exist. Decision needed: build the hook or rewrite §13. This is a documentation-reality gap that breaks trust.

### Next Immediate Actions
- Let the gmail_seen_messages sync complete UNINTERRUPTED
- Query `SELECT COUNT(*) FROM gmail_seen_messages` in Supabase — should be > 0
- If 0: check sync result for CRITICAL error; if present, diagnose Supabase issue; if absent, trace flushSeenBatch logic
- Decide on model-routing hook (build vs. rewrite docs)
- Once gmail_seen_messages is populated, future "Load full history" will be instant (~10 seconds)

## §10 Deployment

- **Local dev:** `npm run dev` in `cardiq-app/` → http://localhost:3000
- **Production:** Vercel — auto-deploys on `git push origin main`
- **Vercel env vars:** Must match §8 above — set in Vercel project settings
- **Supabase:** Migrations run manually in Supabase SQL Editor (in order: 001 → 002 → 003)
