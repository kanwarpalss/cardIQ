# CardIQ — SPEC.md (Source of Truth)

> Last updated: 2026-05-19
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

### Build status (as of 2026-05-19)
| Chunk | Status |
|---|---|
| 1 Schema migration (010_dining_schema.sql) | ✅ Done |
| 2 normalize.ts + tests (35 tests) | ✅ Done |
| 3 http.ts + tests (24 tests) | ✅ Done |
| 4 dedupe.ts + tests (19 tests) | ✅ Done |
| 5 ~~dining-login.ts~~ | ✅ Deleted — no auth needed |
| 6 ~~dining-verify-session.ts~~ | ✅ Deleted |
| 7 API route: search | ✅ Done |
| 8 DiningTab.tsx + nav wiring | ✅ Done |
| 9 scripts/dining-recon.ts | ✅ Done |
| 10 docs/DINING_OFFER_TAXONOMY.md | ✅ Done |
| 11 Migration 012 — booking_type | ✅ Done |
| 12 Per-platform scrapers (district, swiggy, eazydiner) | ✅ Done |
| 13 dining-scrape.ts orchestrator (30 restaurants) | ✅ Done |
| 14 GitHub Action weekly cron | ✅ Done (2-job: discover + scrape) |
| NEW Migration 013 — PostGIS + pg_trgm + spatial indexes | ✅ Done |
| NEW Discovery libs (district sitemap, eazydiner HTML, swiggy search) | ✅ Done — 22 tests |
| NEW dining-discover.ts orchestrator | ✅ Done |
| NEW dining-scrape.ts DB-driven (replaces hardcoded 30) | ✅ Done |
| 15 Manual-link review widget | ⏳ Next |
| 16 DiningTab UI — search/browse at scale | ⏳ Next |

**Discovery architecture (locked 2026-05-19):**
- District: public sitemap → 27K Bangalore outlet URLs → ~5-8K canonical restaurants
- EazyDiner: paginated HTML NEXT_DATA → ~2,100 restaurants with lat/lng
- Swiggy: no bulk listing API; bootstrapped via name-search per canonical + dineout-ID verify
- Swiggy coverage: ~30-50% of canonicals; rest handled by manual-link widget

---

## 5. Decisions Log

| Date | Decision | Rejected alternative | Why |
|---|---|---|---|
| 2026-05 | Playwright login CLI (manual OTP) | Automated OTP | Ethics + fragility |
| 2026-05 | Platform-specific post-login cookie check | Generic "2+ cookies" heuristic | Zomato sets tracking cookies on page load, triggering false positive |
| 2026-05 | GitHub Action for weekly scrape | Vercel cron | Playwright on Vercel is painful (binary size, cold starts) |
| 2026-05 | jsonb for raw payloads | Supabase Storage | Simpler for v1; revisit at 50KB+ per restaurant |
| 2026-05 | Swiggy scraped as guest (no login) | Stored session | All offers (pre-booking + walk-in) visible without auth — confirmed manually |
| 2026-05-19 | District discovery via sitemap (not HTML crawl) | Paginating listing pages | Sitemap is explicitly published, 27K Bangalore URLs, no rate-limit concern |
| 2026-05-19 | EazyDiner discovery via www HTML (not force.eazydiner.com API) | API host | force.eazydiner.com has Disallow:/ in robots; www host is Allow:/ |
| 2026-05-19 | Swiggy: no bulk discovery; bootstrap from D+ED canonicals | Guessing bulk listing endpoint | All dapi variants tested; dineout listing API is gated. Search+verify gets ~30-50% coverage |
| 2026-05-19 | Weekly-only scrape cadence (no hot/warm/cold tiers) | Tiered per-restaurant frequency | YAGNI — weekly is fine to start; tiers add complexity without proven need |

---

## 6. Current State

- **174 tests passing** (74 core + 78 dining + 22 discover), tsc clean
- **Phase 1 discovery in progress** — `npm run dining:discover --phase=1` running (~8,000/27,542 District slugs ingested as of 2026-05-19); EazyDiner ~2,100 also runs in Phase 1
- **Phase 2 code complete** — `discoverSwiggyBatch` built + integrated; run `npm run dining:discover -- --platform=swiggy` once Phase 1 finishes
- **`dining:status` script live** — `npm run dining:status` gives instant DB snapshot (counts by platform, Phase 2 readiness, offer count, review queue, last scrape run)
- **EazyDiner enrichment live** — `scrapeEazyDiner` now returns `{ offers, cuisines, priceForTwo }`; scrape orchestrator writes these back to `dining_restaurants` so DiningTab shows cuisine tags + price
- **Codebase pushed to GitHub** — first push to `origin/master`; Vercel auto-deploy triggered for light-theme + all recent work
- **Migrations 013 + 014 applied** — PostGIS, pg_trgm, spatial index, dedupe queue all live in Supabase
- **Manual-link review widget live** — `GET/POST /api/dining/review`, "Link review (N)" button in DiningTab header
- **Shell alias system** — `~/.zshrc` + `~/.local-apps.sh` created; `apps` command shows all; `cardiq-dev` starts server + opens browser

---

## 7. Known Issues

| Issue | Status |
|---|---|
| Walmart network blocks Supabase Cloud, jsdelivr CDN, Frankfurter | Ongoing — use Eagle WiFi or hotspot |
| fawazahmed0 FX only goes back to 2024-03-06 | Accepted — older exotic-currency txns fall back to today's rate |
| No mobile-optimised UI | Not planned for v1 |
| WhatsUp pm2 process errored on Mac Mini | Investigate separately — unrelated to cardIQ |
| `CARDIQ_VERCEL` placeholder in `~/.local-apps.sh` | Fill in actual Vercel URL from vercel.com/dashboard after Vercel deploy confirms |
| Swiggy Dineout: `tabsOfferInfo.offersTab` prebook deals require Swiggy login to redeem | Data is guest-readable; display the offer, note "Login to buy" in UI |
| EazyDiner `cuisines`/`average_cost` field names unconfirmed against live API | `extractCuisines` + `extractPriceForTwo` have multi-key fallbacks; run `dining:scrape -- --dry-run --slug "Toit"` to verify after Phase 1 completes |

---

## 8. How to Run

```bash
# Must be on Eagle WiFi / hotspot (not Walmart network)
npm run dev                              # localhost:3000
npx vitest run                           # 174 tests, all must pass
npx tsc --noEmit                         # must be clean
./scripts/db.sh push                     # apply migrations (run 013 before discover)

# First-time discovery (all Bangalore restaurants)
npm run dining:discover                  # Phase 1 + 2 (~4-6h for Swiggy bootstrap)
npm run dining:discover -- --phase=1     # Phase 1 only: District + EazyDiner (~15 min)
npm run dining:discover -- --dry-run     # print counts without writing to DB

# Offer scrape (DB-driven, requires discover to have run first)
npm run dining:scrape                    # all restaurants
npm run dining:scrape -- --slug "Toit"  # filter by name
npm run dining:scrape -- --dry-run      # print only

# Status snapshot (counts by platform, Phase 2 readiness, last scrape run)
npm run dining:status

# Recon (for new offer taxonomy analysis)
npm run dining:recon                     # all 30 original restaurants × 3 platforms
```

---

## 9. Session Handoff Notes

*(Updated 2026-05-19 — end of session)*

- **Phase 1 still running:** ~8,000/27,542 District slugs ingested. Let it finish — don't kill or restart. Once done, run `npm run dining:status` to confirm counts, then `npm run dining:discover -- --platform=swiggy` to kick off Phase 2.
- **Phase 2 code complete:** `discoverSwiggyBatch` is fully wired in `dining-discover.ts`. Phase 2 runs in isolation with `--platform=swiggy` — safe to run while Phase 1 DB rows are still being ingested.
- **New this session:** `dining:status` script (quick DB snapshot), `scrapeEazyDiner` now returns cuisines + priceForTwo, scrape orchestrator writes them to `dining_restaurants`, full codebase pushed to GitHub (triggers Vercel deploy).
- **Vercel deploy triggered:** First push to `origin/master`. Check vercel.com/dashboard for deploy status. Once live, fill `CARDIQ_VERCEL` in `~/.local-apps.sh`.
- **Next session:** (1) Verify Phase 1 completed (`dining:status`); (2) run Phase 2 Swiggy (`--platform=swiggy`); (3) confirm Vercel deploy is live + grab URL; (4) run a dry-run scrape (`--dry-run --slug "Toit"`) to verify EazyDiner cuisine/price field names against live API.

---

## 10. Deployment

| Item | Value |
|---|---|
| Hosting | Vercel |
| Supabase project | Linked via `supabase/.temp/linked-project.json` |
| Dining scripts | Run locally on KP's Mac (not Vercel) |
| pm2 / Tailscale | Not used (Vercel-hosted, not Mac Mini) |
| Mac Mini env | Has its own `.env.local` — update separately from laptop |
