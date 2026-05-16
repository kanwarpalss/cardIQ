# HANDOFF.md — paste this to start any new conversation about CardIQ

**Purpose**: drop this into a fresh chat so the next assistant (or
future-you in 3 weeks) has full context without re-discovery.

---

## What CardIQ is

A personal credit-card spend tracker. Reads your Gmail (read-only OAuth),
extracts transaction emails from Indian banks (Axis, HDFC, ICICI, HSBC),
parses them, deduplicates, stores to Supabase, and displays:
- Aggregates by card / category / merchant
- Foreign-currency txns separately (with INR conversion at txn-date AND today's rate)
- Milestone tracking (₹1.5L windows for fee waivers)
- Notes + recategorization

**One user (KP)**. Built for personal use. Hosted on Vercel.

---

## Stack

- Next.js 14 (App Router) + TypeScript + Tailwind
- Supabase (Postgres + Auth, Google OAuth with Gmail scope)
- Vitest for tests (74 tests, all green)
- Free tier everything

---

## Project location

`/Users/k0s0k30/Code/cardIQ` on KP's Mac.

---

## Critical files (read before changing anything)

- **`LEARNINGS.md`** ← read this FIRST. Has principles + project knowledge.
- `src/lib/currency.ts` — currency detection (single source of truth)
- `src/lib/txn-enrich.ts` — DRY chokepoint for transaction enrichment
- `src/lib/historical-fx.ts` — pluggable FX provider chain
- `src/lib/parsers/{axis,hdfc,icici,hsbc}.ts` — bank parsers
- `src/lib/parsers/generic-sniffer.ts` — fallback for unknown formats
- `src/components/SpendTab.tsx` — main dashboard (INR aggregates)
- `src/components/ForeignCurrencyPanel.tsx` — quarantined foreign txns
- `supabase/migrations/` — numbered SQL, all idempotent

---

## What's been built (chronological)

1. **Initial app** — Next.js + Supabase auth + Gmail OAuth
2. **Sync v1** — fetch txns from Gmail, parse, store
3. **Spend dashboard** — totals + by-category + by-merchant + milestones
4. **Card management** — add cards, link parsed txns by last-4
5. **Notes + recategorization** — manual override of parser categories
6. **Multi-currency support** — added when SOFITEL Bali charge inflated INR by ₹1.2cr (parser thought IDR amount was INR)
7. **Historical FX** — txn-date rates instead of today's, cached in `fx_rates` table
8. **Sync UX cleanup** — consolidated buttons, 8-year first sync, dedupe via `gmail_seen_messages`
9. **Foreign panel hardening** — dual-INR display, refresh-missing-rates button, ±7-day fallback, Frankfurter as secondary FX provider

---

## Currently open / known limitations

- **Walmart network blocks Supabase Cloud + jsdelivr CDN + Frankfurter.**
  Dev requires Eagle WiFi or phone hotspot. Migrations can be pasted
  into the Supabase dashboard SQL editor as fallback.
- **fawazahmed0 FX API** only has data from 2024-03-06. Older txns
  rely on Frankfurter (which doesn't cover IDR/THB/MYR/HKD). For those
  exotic currencies pre-2024, we have no historical rate — falls back
  to today's rate or 0.
- **Single-user app** — no multi-tenant concerns, but RLS policies
  are still in place per user_id.
- **No mobile-specific UI** — works in mobile Safari but not optimized.

---

## Most recent bugs fixed (last conversation)

| Bug | Root cause | Principle (see LEARNINGS.md) |
|---|---|---|
| "1 new transaction" every sync | Supabase `.select()` 1000-row default cap | G1 |
| Missing FX rates for older txns | Single-provider with date-coverage limits | G2 |
| Foreign txn count looked stuck at 146 | Just real data + missing "All time" preset | G12 |
| "By category" infinite scroll | No pagination | G12 |

---

## How to run

```bash
cd /Users/k0s0k30/Code/cardIQ
# (must be on Eagle WiFi / hotspot / off-Walmart-VPN)
npm run dev          # localhost:3000
npx vitest run       # 74/74 must pass
npx tsc --noEmit     # must be clean
./scripts/db.sh push # apply migrations (or paste in dashboard)
```

---

## Conventions to follow

1. **Read LEARNINGS.md before non-trivial changes.** It's not optional.
2. Every transaction write path **must** go through `enrichAmount()`.
3. Currency detection **must** use `lib/currency.ts` — never roll your own regex.
4. Migrations **must** be idempotent (`IF NOT EXISTS`, `DROP IF EXISTS`).
5. Tests must stay green. Add a regression test for any non-trivial bug fix — copy the failing input verbatim.
6. Commit messages reference the LEARNINGS.md principle when applicable: `fix(sync): paginate knownMsgIds (G1)`.
7. **Never force-push.**

---

## Pending ideas / wishlist (not yet started)

- Anthropic-backed chat for "what did I spend on flights last quarter?"
- Card recommendation engine (knowledge base of cards + your spend
  pattern → "switch from Magnus to Atlas because…")
- Reward-points tracking per card
- Statement-period view (not just calendar months)
- Export to CSV / GST helper

---

## Dining tab (in progress, May 2026)

Goal: aggregate restaurant listings + native discounts from Zomato
Dining Out, Swiggy Dineout, EazyDiner. Dedupe across platforms.
Weekly refresh. Card-stack offers are Phase 2.

**Design docs** (read in this order):
- `docs/DINING_FEASIBILITY.md` — why no public API, options
  considered.
- `docs/DINING_BUILD_PLAN.md` — 9 chunks, data model, decisions.
- `docs/DINING_SCRAPE_STRATEGY.md` — two-tier endpoints ×
  three-tier freshness; bootstrap math; politeness policy.
- `docs/DINING_RUNBOOK.md` — what KP runs on the Mac mini.

**Shipped so far (committed, tested):**
- `supabase/migrations/010_dining_schema.sql` — 7 new tables.
- `src/lib/dining/normalize.ts` + tests — name/area cleaning,
  haversine, Levenshtein, `matchConfidence()`. 35 tests.
- `src/lib/dining/http.ts` + tests — polite fetch wrapper with
  jitter, backoff, captcha sniff, hard-abort policy. 24 tests.
- `src/lib/dining/dedupe.ts` + tests — incremental dedupe +
  post-run merge; honours manual overrides. 19 tests.
- `src/lib/dining/sessions.ts` — encrypted session storage
  (mirrors crypto pattern from Gmail OAuth).
- `scripts/dining-login.ts` — Playwright CLI: opens browser, KP
  logs in by hand, saves encrypted session to Supabase.
- `scripts/dining-verify-session.ts` — sanity-check that captured
  sessions decrypt cleanly and aren't expired.
- `src/app/api/dining/search/route.ts` — search + best-offer ranking.
- `src/app/api/dining/sessions/status/route.ts` — backs re-auth banner.
- `src/components/DiningTab.tsx` + nav wiring in `app/page.tsx` —
  full UI: search box, per-restaurant card with all 3 platforms
  side-by-side, re-auth banner, session health dots, empty states.
- `package.json` — added `playwright`, `tsx`, `dotenv` devDeps;
  `npm run dining:login` shortcut.

Total tests: 152 (74 existing + 78 dining-related).

**Not yet built (next session, after KP captures sessions on Mac mini):**
- Per-platform scrapers (chunks 5b–5d). Need real API fixtures first —
  capture by logged-in browser DevTools or via a small fixture-grab
  script using the already-stored sessions.
- Discovery + detail orchestrator (`scripts/dining-scrape.ts`).
- Hot/warm/cold tier classification (joins to existing transactions).
- Mutations API: POST /api/dining/manual-links (decide same/different).
- Manual-link review widget in DiningTab.
- launchd plist for the weekly schedule.

---

## How to start a new conversation

Paste this into the new chat:

> I'm working on CardIQ, a personal credit-card tracker at
> `/Users/k0s0k30/Code/cardIQ`. Please read `HANDOFF.md` and
> `LEARNINGS.md` in that directory before making any changes — they
> contain the architecture, conventions, and accumulated principles
> from past bug-fixes. Then [your specific request].

That's it. The two docs carry the full context.
