# CardIQ — SPEC.md (Source of Truth)

> Last updated: 2026-05-17
> One user: KP. Solo project. Personal use only. Hosted on Vercel.

---

## 1. What CardIQ Is

A personal credit-card spend tracker. Reads Gmail (read-only OAuth), extracts transaction emails from Indian banks (Axis, HDFC, ICICI, HSBC), parses them, deduplicates, stores to Supabase, and displays:

- Aggregates by card / category / merchant
- Foreign-currency txns separately (with INR conversion at txn-date AND today's rate)
- Milestone tracking (₹1.5L windows for fee waivers)
- Notes + recategorization
- **Dining tab** (in progress): best offers across Zomato Dining Out, Swiggy Dineout, EazyDiner — deduplicated, weekly-refreshed

---

## 2. Stack

- **Frontend/Backend:** Next.js 14 (App Router) + TypeScript + Tailwind
- **Database:** Supabase (Postgres + Auth, Google OAuth with Gmail scope)
- **Tests:** Vitest — 152 tests total (74 core + 78 dining)
- **Scraping:** Playwright (CLI-only, runs on KP's Mac)
- **Hosting:** Vercel (free tier)
- **Cost:** Free tier everything

---

## 3. Architecture

### Core data flow
Gmail → Parser → `enrichAmount()` → Supabase → Dashboard

### Critical files (read before touching)
| File | Role |
|---|---|
| `src/lib/currency.ts` | Currency detection — single source of truth, never bypass |
| `src/lib/txn-enrich.ts` | DRY chokepoint for every transaction write |
| `src/lib/historical-fx.ts` | Pluggable FX provider chain (fawazahmed0 → Frankfurter) |
| `src/lib/parsers/{axis,hdfc,icici,hsbc}.ts` | Bank-specific email parsers |
| `src/lib/parsers/generic-sniffer.ts` | Fallback for unknown formats |
| `src/lib/dining/sessions.ts` | Encrypted session storage for dining logins |
| `src/lib/dining/normalize.ts` | Name/address cleaning, haversine, Levenshtein for dedupe |
| `src/lib/dining/http.ts` | Polite fetch wrapper: jitter, backoff, captcha sniff |
| `src/lib/dining/dedupe.ts` | Incremental cross-platform restaurant dedupe |
| `src/components/SpendTab.tsx` | Main spend dashboard |
| `src/components/DiningTab.tsx` | Dining search + offer display |
| `supabase/migrations/` | Numbered SQL, all idempotent |

### Invariants
1. Every transaction write **must** go through `enrichAmount()`.
2. Currency detection **must** use `lib/currency.ts`.
3. Migrations **must** be idempotent (`IF NOT EXISTS` / `DROP IF EXISTS`).
4. Tests must stay green. Regression test = verbatim failing input.
5. Never force-push.

---

## 4. Dining Tab — Design

### Goal
"Tell me if restaurant X is on Zomato, Swiggy, or EazyDiner, and which has the best offer right now — without me opening any of them."

### Auth model
- **No auth required.** All three platforms confirmed guest-accessible (2026-05-17).
- Scrapers make plain HTTP requests — no stored sessions, no Playwright, no re-auth banners.
- If a platform gates guest access in the future, add auth then. YAGNI.

### Platforms
| Platform | Auth needed? | Login URL | Post-login cookies to detect |
|---|---|---|---|
| Zomato | Yes | zomato.com/bangalore/dine-out | `userid`, `zat`, `access_token` |
| Swiggy | **No** — guest access shows all offers | scraper uses plain HTTP | n/a |
| EazyDiner | Yes | eazydiner.com/bangalore/restaurants | `ed_token`, `ed_user`, `ed_auth` |

### Decisions locked (from DINING_BUILD_PLAN.md §6)
- D1: Bangalore only (v1)
- D2: GitHub Action weekly cron
- D3: Raw JSON in Supabase jsonb (revisit if >50KB/restaurant)
- D4: Headline + full terms text (expandable in UI)
- D5: Red banner in Dining tab on expiry

### Build status (as of 2026-05-17)
| Chunk | Status |
|---|---|
| 1 Schema migration (010_dining_schema.sql) | ✅ Done |
| 2 normalize.ts + tests (35 tests) | ✅ Done |
| 3 http.ts + tests (24 tests) | ✅ Done |
| 4 dedupe.ts + tests (19 tests) | ✅ Done |
| 5 ~~dining-login.ts~~ | ✅ Deleted — no auth needed (all platforms guest-accessible) |
| 6 ~~dining-verify-session.ts~~ | ✅ Deleted |
| 7 API route: search | ✅ Done |
| 8 DiningTab.tsx + nav wiring | ✅ Done (re-auth banner removed, prebook/walk-in split added) |
| 9 scripts/dining-recon.ts — guest scrape ~30 restaurants × 3 platforms, dump JSON | ⏳ Next |
| 10 docs/DINING_OFFER_TAXONOMY.md — analyze recon dumps, define offer type schema | ⏳ Pending |
| 11 Migration 012 — add booking_type + revise offer_type enum per taxonomy | ⏳ Pending |
| 12 Per-platform scrapers (zomato, swiggy, eazydiner) | ⏳ Pending |
| 13 dining-scrape.ts orchestrator | ⏳ Pending |
| 14 GitHub Action weekly cron | ⏳ Pending |
| 15 Manual-link review widget | ⏳ Pending |

**Next action:** Run `npm run dining:recon` after recon script is built. Dumps JSON to `recon/` folder, generates `recon/SUMMARY.md`. We analyze, define taxonomy, then build production scrapers.

**Offer type requirement:** Both `prebooking` and `walkin` offers shown per platform. Migration 012 adds `booking_type` to `dining_offers` once taxonomy is confirmed from real data.

---

## 5. Decisions Log

| Date | Decision | Rejected alternative | Why |
|---|---|---|---|
| 2026-05 | Playwright login CLI (manual OTP) | Automated OTP | Ethics + fragility |
| 2026-05 | Platform-specific post-login cookie check | Generic "2+ cookies" heuristic | Zomato sets tracking cookies on page load, triggering false positive |
| 2026-05 | GitHub Action for weekly scrape | Vercel cron | Playwright on Vercel is painful (binary size, cold starts) |
| 2026-05 | jsonb for raw payloads | Supabase Storage | Simpler for v1; revisit at 50KB+ per restaurant |
| 2026-05 | Swiggy scraped as guest (no login) | Stored session | All offers (pre-booking + walk-in) visible without auth — confirmed manually |

---

## 6. Current State

- 152 tests passing (74 core + 78 dining), tsc clean
- **Auth infrastructure deleted** — no sessions, no Playwright, no re-auth banner
- `dining-login.ts`, `dining-verify-session.ts`, `sessions.ts` removed; `Platform` type moved to `src/lib/dining/types.ts`
- `DiningTab.tsx` updated: re-auth banner gone, prebook/walk-in offer split added to UI
- `scripts/dining-recon.ts` built — 30-restaurant guest scrape, dumps to `recon/<platform>/`
- **Swiggy Dineout endpoint: NOT YET FOUND** — current recon hits food-delivery search, not dineout
- **Zomato endpoint: requires CSRF token** — autoSuggest returns empty without it; need two-step flow
- **EazyDiner endpoint: NOT YET FOUND** — 404 on guessed path
- Migration `011_drop_dining_sessions.sql` created (not yet applied)

---

## 7. Known Issues

| Issue | Status |
|---|---|
| Walmart network blocks Supabase Cloud, jsdelivr CDN, Frankfurter | Ongoing — use Eagle WiFi or hotspot |
| fawazahmed0 FX only goes back to 2024-03-06 | Accepted — older exotic-currency txns fall back to today's rate |
| No mobile-optimised UI | Not planned for v1 |
| Zomato autoSuggest returns empty without CSRF token | Next session — fetch CSRF first, then search |
| Swiggy recon hitting food-delivery API, not Dineout | Next session — find dineout-specific endpoint via DevTools |
| EazyDiner search endpoint unknown | Next session — DevTools capture needed |
| Migration 011 not yet applied to Supabase | Run `./scripts/db.sh push` when ready |

---

## 8. How to Run

```bash
# Must be on Eagle WiFi / hotspot (not Walmart network)
npm run dev                              # localhost:3000
npx vitest run                           # 152 tests, all must pass
npx tsc --noEmit                         # must be clean
./scripts/db.sh push                     # apply migrations

# Dining recon (find correct API endpoints before building scrapers)
npm run dining:recon                     # all 30 restaurants × 3 platforms
npm run dining:recon -- --platform zomato --slug toit   # single test
```

---

## 9. Session Handoff Notes

*(Updated 2026-05-17)*

- **Big pivot this session:** All 3 platforms confirmed guest-accessible. Deleted entire auth stack (sessions, Playwright, re-auth banner). DiningTab updated with prebook/walk-in split UI.
- **Recon script built** (`scripts/dining-recon.ts`): guest scrapes 30 Bangalore restaurants × 3 platforms, dumps raw JSON to `recon/`, generates `recon/SUMMARY.md`. Swiggy returns data but from food-delivery API (not Dineout). Zomato needs CSRF token first. EazyDiner endpoint unknown.
- **Next session priority 1:** Fix Zomato — fetch `https://www.zomato.com/webroutes/csrf` first to get token, then use it in `autoSuggest?context=dineout&q=<name>`. Also find correct Swiggy Dineout + EazyDiner endpoints via DevTools (same process KP already did for Zomato).
- **Next session priority 2:** Once all 3 platforms return real offer data, read the raw JSONs and write `docs/DINING_OFFER_TAXONOMY.md` — the taxonomy doc that gates all scraper code.
- Tests: 152/152 passing, tsc clean. `Platform` type now lives in `src/lib/dining/types.ts`.

---

## 10. Deployment

| Item | Value |
|---|---|
| Hosting | Vercel |
| Supabase project | Linked via `supabase/.temp/linked-project.json` |
| Dining scripts | Run locally on KP's Mac (not Vercel) |
| pm2 / Tailscale | Not used (Vercel-hosted, not Mac Mini) |
| Mac Mini env | Has its own `.env.local` — update separately from laptop |
