# CardIQ — SPEC

> Project brain. Updated every session.
> Static architecture doc lives in ARCHITECTURE.md — don't duplicate it here.
> Last updated: 2026-07-08

---

## §1 What This Is

A one-stop credit-card destination: syncs bank transaction emails from Gmail (Axis, HDFC, ICICI, HSBC), parses + categorizes them into a spend dashboard, and marries that with reward balances, card offers, and airline/hotel loyalty statuses — plus AI chat. Hosted on Vercel (Next.js), database on Supabase (Postgres + Auth), Gmail access via Google OAuth. Built for KP today; RLS keeps it multi-user-ready for the future.

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
| `src/components/OverviewTab.tsx` | Home: hero stats, card-art tiles, rewards/offers/loyalty panels |
| `src/components/SpendTab.tsx` | Main spend dashboard UI |
| `src/components/RewardsTab.tsx` | Per-card point balance snapshots + history |
| `src/components/OffersTab.tsx` | Card offers CRUD with expiry chips + status filters |
| `src/components/LoyaltyTab.tsx` | Airline/hotel program tiers, member ids, expiry warnings |
| `src/components/MerchantPanel.tsx` | By-merchant panel with inline name + category editing |
| `src/lib/perks.ts` | Pure logic for rewards/offers/loyalty (unit-tested in perks.test.ts) |
| `src/lib/card-art.ts` | Issuer-true gradients per card product |
| `src/lib/format.ts` | Single home for ₹/number/date formatting (ARCH-04) |
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
- `gmail_sync_state` — per-user incremental sync cursor (last_internal_date)
- `gmail_seen_messages` — every fetched email ID (success/skip/error) so nothing re-downloads
- `reward_balances` — card-point balance snapshots (migration 009; latest as_of = current)
- `offers` — user-tracked card offers with validity windows (migration 009)
- `loyalty_accounts` — airline/hotel program tiers + points, card-independent (migration 009)

## §5 Decisions Log

| Date | Decision | Rejected alternative | Why |
|---|---|---|---|
| 2026-05-07 | Merchant lookup uses two-pass: raw_name first, then cleanMerchant(raw) | Single-pass raw only | Display overrides saved via UI use cleaned name as key; raw fallback ensures future syncs still respect them |
| 2026-05-07 | Inline merchant edit updates ALL transactions with that name | Prompt "apply to all?" | Less friction; bulk rename is always the right UX for merchant overrides |
| 2026-05-07 | Extracted MerchantPanel to separate component | Keep in SpendTab | SpendTab was approaching 600-line limit; edit state belongs close to the panel it controls |
| 2026-07-08 | Rewards/offers/loyalty are manual-entry in V1, with a `source` column (manual\|parsed) | Auto-compute balances from txns × earn rate | Computed balances drift into fiction (exclusions, bonuses, redemptions); a wrong number shown confidently is worse than a dated manual one. `source` column lets V2 email-parsing write into the same tables |
| 2026-07-08 | Three separate tables (reward_balances / offers / loyalty_accounts) | One generic "points" table | Card points die with the card (FK cascade); loyalty statuses outlive cards (no FK); offers are time-boxed and optionally card-linked (set-null) — different lifecycles, different shapes |
| 2026-07-08 | Sidebar shell (desktop) + pill nav (mobile), 8 sections | Keep flat top tabs | 8+ tabs overflow a top bar; sidebar scales as sections grow — "keep adding sections" is an explicit requirement |
| 2026-07-08 | New tabs do CRUD via Supabase client directly (CardsTab pattern) | Dedicated API routes | RLS already enforces per-user access; routes added no security, only boilerplate. Secrets stay in server routes as before |

## §6 Current State (as of 2026-07-08)

**New this session (holistic redesign):**
- Overview home tab: greeting + hero stats, issuer-true card-art tiles (milestone progress + base-rate point estimates), rewards/offers/loyalty summary panels; card tiles deep-link into Spend filtered to that card
- Rewards tab: per-card balance snapshots with history, deltas, staleness flags (>45 days → amber)
- Offers tab: CRUD with expiry chips ("3d left" / "No expiry" / expired), status filters (active/used/expired/archived)
- Loyalty tab: airline/hotel/other programs — tier chips, member ids, tier + points expiry warnings
- New shell: grouped sidebar nav (desktop) + horizontal pill nav (mobile); ambient gold aura backdrop
- CardSpec now carries reward program + base earn rate for all 5 cards
- Migration 009 (reward_balances, offers, loyalty_accounts — all RLS own-rows, all with source manual|parsed) — ⚠ NOT YET RUN in Supabase; new tabs show a run-migration notice until it is
- perks.ts pure logic + 15 boundary tests; .eslintrc.json added (lint now actually runs)

**Working (carried forward):**
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
- Migration 009 must be run manually in Supabase SQL Editor before Rewards/Offers/Loyalty can save data (tabs show a plain-English notice until then).
- Authed dashboard visuals of the 2026-07-08 redesign verified by build + tests + login-page render only — KP click-through pending (Google OAuth can't be done headlessly).

## §7 Known Issues

| Issue | Status | Notes |
|---|---|---|
| gmail_seen_messages population | 🟡 VERIFY | The May-09 "Load full history" blocker predates two months of sync work (gap-detector, sync dropdown, ICICI domain fix) — likely resolved, but confirm with `SELECT COUNT(*) FROM gmail_seen_messages` when next in Supabase. |
| Model routing hook missing | ✅ RESOLVED | The model-routing gate fired via UserPromptSubmit hook on 2026-07-08 — the hook exists and works. |
| Recategorize re-cooks ALL transactions | Pending fix | Should only re-cook transactions affected by changed mappings/rules. |
| No `raw_merchant` stored in transactions | Accepted for now | merchant_mappings uses cleaned name as raw_name key; two-pass lookup compensates. |
| Point estimates are base-rate only | Accepted (by design) | Card tiles show "≈ N pts (base-rate estimate)" — accelerated/bonus earn not modeled; real balances come from the Rewards tab. |

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

## §9 Session Handoff Notes (2026-07-08)

### Accomplished This Session
1. **Holistic architecture layer** — migration 009 (reward_balances, offers, loyalty_accounts; RLS own-rows; `source` column future-proofs V2 email-parsing). CardSpec gained reward program + earn rates for all 5 cards.
2. **Full UX redesign** — sidebar shell (desktop) + pill nav (mobile), new Overview home (hero stats, issuer-true card-art tiles with milestone progress + point estimates, rewards/offers/loyalty panels), three new tabs (Rewards, Offers, Loyalty). Card tiles deep-link to Spend filtered per card.
3. **Quality** — perks.ts pure logic with 15 boundary tests (177 total green), typecheck + lint + prod build clean, .eslintrc.json added, two pre-existing lint errors fixed. Devil's-advocate pass run pre-build (5 CRIT citations recorded).
4. **SPEC brought back to truth** — May-09 blockers re-triaged, table list + decisions log updated.

### ▶ Start next session here
1. **KP: run migration 009** in Supabase SQL Editor (paste `supabase/migrations/009_rewards_offers_loyalty.sql`, Run). Until then the three new tabs show a setup notice.
2. **KP: click through the redesign** on localhost (Overview → card tile → Spend deep-link; add a reward balance, an offer, a loyalty program) — my verification stopped at the login wall.
3. Verify `gmail_seen_messages` count in Supabase (stale May flag — likely fine).
4. When happy: `git push origin main` deploys to Vercel (3 local commits waiting).

## §10 Deployment

- **Local dev:** `npm run dev` at repo root → http://localhost:3000 (repo was flattened 2026-06-28; there is no `cardiq-app/` subfolder anymore)
- **Production:** Vercel — auto-deploys on `git push origin main`
- **Vercel env vars:** Must match §8 above — set in Vercel project settings
- **Supabase:** Migrations run manually in Supabase SQL Editor, in numeric order (001 → … → 009)
