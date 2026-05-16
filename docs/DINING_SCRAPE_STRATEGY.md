# Dining tab — scraping strategy (addendum to BUILD_PLAN)

**Date**: 2026-05-16
**Status**: Decisions locked. Answers KP's "how does this actually work
at scale" question. Supersedes §3, D2, and chunk 5 of BUILD_PLAN.

---

## Decisions locked

| ID | Decision | Value |
|---|---|---|
| D1 | City scope v1 | **Bangalore only** |
| D2 | Scraper host | **launchd on KP's Mac mini** (revised — see §1) |
| D3 | Raw payload storage | jsonb (default) |
| D4 | Offer terms detail | Full terms (default) |
| D5 | Re-auth alert | Banner only |

---

## 1. Why Mac mini > GitHub Action (revised)

Original plan said GitHub Action. Now that the host is KP's always-on
Mac mini on residential broadband:

| Factor | Mac mini launchd | GitHub Action |
|---|---|---|
| IP reputation | **Residential, clean** | Datacenter, often pre-flagged by Cloudflare/Akamai |
| Playwright setup | Native, just works | Possible but fiddly (apt installs, browser binary cache) |
| Logs/debugging | `~/Library/Logs/`, instant `tail -f` | Workflow run UI, slower iteration |
| Cost | $0 | $0 (under free minutes) |
| Failure mode | Mac off → run skipped (visible in `dining_runs` gaps) | Free minutes burn → silent skip |
| Personal-account isolation | Trivially clean | Trivially clean |

**Decision: launchd on Mac mini.** GitHub Action stays as a documented
fallback if the Mac is ever offline for a long stretch.

A LaunchAgent plist at
`~/Library/LaunchAgents/com.cardiq.dining.plist` invokes:
```
cd /Users/<kp>/Code/cardIQ && /opt/homebrew/bin/npx tsx scripts/dining-scrape.ts
```
Schedule: weekly discovery sweep Sundays 04:00 IST, plus a nightly
"hot tier" refresh at 03:30 IST (see §3).

---

## 2. The real numbers we're dealing with (Bangalore)

Rough order-of-magnitude in May 2026 (will verify in chunk 5):

| Platform | Listed restaurants in BLR | Endpoints we care about |
|---|---|---|
| Zomato Dining Out | 8k–12k | `/webroutes/search` (list, by locality), `/getPage` (detail) |
| Swiggy Dineout | 3k–5k | `/dineout-api/v1/listing` (list, by locality), `/dineout-api/v1/restaurant/{id}` (detail) |
| EazyDiner | 1.5k–2.5k | `/restaurants/list` (list, by area), `/restaurants/{slug}` (detail) |
| **Union after dedupe** | **~10k–15k unique** | |

15k restaurants × weekly detail fetch = 15k/week ≈ 90/hour. Doable
but wasteful and noisy. We don't actually need that.

---

## 3. The strategy: two endpoint tiers × three freshness tiers

### 3a. Two endpoint tiers per platform

Every platform's API has the same shape:

- **List endpoint** — paginated by locality. Returns 20–50 restaurants
  per page with **basic info + headline offer snippet**. Cheap. One
  Bangalore-wide sweep ≈ ~80 localities × ~3 pages each × 3 platforms
  = **~700 calls per discovery sweep, finishes in ~25 min** at 0.5–1
  call/sec/platform with jitter.

- **Detail endpoint** — per restaurant. Returns **full offer terms,
  menu, photos, T&Cs**. The expensive thing.

The headline offer string from the list endpoint is enough to detect
"did the offer change?" without paying for the detail call. That's
the whole trick.

### 3b. Three freshness tiers for detail fetches

Not every restaurant deserves the same attention:

| Tier | What's in it | Size | Detail refresh |
|---|---|---|---|
| **🔥 Hot** | Restaurants KP has actually paid at (join `dining_listings` × CardIQ's existing transactions on merchant name + locality) | ~50–200 | **Nightly** |
| **♨️ Warm** | Restaurants in localities where KP transacts (Koramangala, Indiranagar, etc. — derived from CardIQ data) **OR** anything where the list-endpoint headline changed since last sweep **OR** anything KP searched in the tab in the last 30d | ~1k–2k | **Weekly** (Sun discovery sweep) |
| **🧊 Cold** | Everything else | ~10k–13k | **On-demand only** — when KP clicks the restaurant in the UI, we kick off a detail fetch with a "fetching fresh offers…" spinner. Falls back to the list-endpoint snippet meanwhile. |

**This is the CardIQ-native insight.** We already know which
restaurants matter to KP — they're in his transaction history. We
don't burn requests re-detailing 12k restaurants he'll never visit.

Math check:
- Hot nightly: 200 × 7 = 1,400 detail calls/week.
- Warm weekly: 2,000 calls/week.
- Cold on-demand: maybe 5–20/week based on how much KP browses.
- **Total: ~3,500 detail calls/week ≈ 500/day ≈ 1 every ~3 min.**
  Trivially within "looks like a human using the app".

Plus the 700-call discovery sweep on Sundays.

---

## 4. First-time bootstrap (the "how do you ever fill 15k rows" question)

Crucially: **bootstrap is NOT "fetch detail for 15k restaurants on day
1"**. It's:

| Step | What | Calls | Time |
|---|---|---|---|
| 1 | One discovery sweep across all BLR localities × 3 platforms | ~700 list calls | ~25 min |
| 2 | Compute hot tier by joining listings ↔ KP's CardIQ transactions | 0 (DB-only) | seconds |
| 3 | Detail fetch the hot tier only (~150 restaurants) | ~150 detail calls | ~10 min |
| 4 | Dedupe across platforms (§5 of BUILD_PLAN) | 0 (DB + embedding cache) | ~2 min |
| 5 | UI is now useful: search any restaurant (basic info + headline offer from list endpoint), full detail for hot tier | — | — |

**Total day-1 cost: ~850 API calls across 3 platforms in ~40 min.**

Then the warm-tier weekly cron starts adding ~2k detail rows/week.
Within a month, anything KP is realistically going to dine at has
full detail. Cold tier fills opportunistically forever.

---

## 5. Resumption, idempotency, observability

Three guardrails so a half-finished run never corrupts state:

```sql
-- Tracks every list-endpoint page hit, so a crashed run resumes
-- exactly where it stopped instead of re-walking from page 1.
create table dining_scrape_pages (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid references dining_runs(id) on delete cascade,
  platform        text not null,
  locality        text not null,
  page            integer not null,
  status          text not null,         -- 'ok' | 'http_4xx' | 'http_5xx' | 'parse_failed' | 'rate_limited'
  http_code       integer,
  fetched_at      timestamptz default now(),
  unique (run_id, platform, locality, page)
);
```

- **Resumable**: `scripts/dining-scrape.ts --resume <run_id>` picks
  up only `status != 'ok'` rows.
- **Idempotent**: detail upserts on `(platform, external_id)`, offers
  written with `snapshot_run_id` so they never collide across runs.
- **Observable**: `dining_runs` row per platform per city per run;
  `status='partial'` if any page failed; CardIQ tab shows last-run
  age + per-platform health dots.

Mirrors how `gmail/sync/route.ts` already handles the "8 years of
email in chunks, resumable, dedupe" pattern. Same shape, different
domain.

---

## 6. Anti-detection politeness (the boring-but-critical bit)

For each platform's HTTP client (`lib/dining/http.ts`, shared
wrapper):

- **0.5–2.0 s random jitter** between consecutive calls to the same
  host.
- **Per-host single-flight** (no parallel calls to the same platform).
  Across platforms, fine to interleave.
- **Real-browser User-Agent** rotated weekly from a small fixed list
  (no exotic identifiers — looks suspicious).
- **Reuse session cookies** from `dining_sessions` (logged-in
  requests are way less likely to be challenged than anonymous).
- **Exponential backoff on 429** (2s → 4s → 8s → abort after 3 tries
  and mark page `rate_limited`; resume next run).
- **Hard abort on 403 / captcha HTML** → `dining_runs.status = 'blocked'`,
  banner in UI. We never try to bypass a challenge.
- **Time-of-day**: cron runs 03:00–05:00 IST when these platforms see
  near-zero legit traffic from KP's IP, blending in is moot, but
  it's also when their own infra is least loaded.

---

## 7. What changes in BUILD_PLAN chunk 5

Chunk 5 in BUILD_PLAN said "pull listings + offers for one city".
With tiered freshness, that splits into:

- **5a** — `lib/dining/http.ts` shared client (politeness, backoff,
  session injection, retry).
- **5b** — `lib/dining/scrapers/zomato.ts` — list-endpoint walker
  for one locality. Tests with a captured fixture.
- **5c** — Same shape for Swiggy, then EazyDiner.
- **5d** — Detail-fetch function per platform (same files), tested
  same way.
- **5e** — `scripts/dining-scrape.ts` orchestrator: discovery sweep,
  tier-classification join against CardIQ txns, detail-fetch
  scheduler, `dining_runs` bookkeeping, resume flag.

Each is independently committable. 5a is the hardest because politeness
math; 5b–d are essentially the same code three times.

---

## 8. What this does NOT do (still YAGNI)

- No proxies / IP rotation. If KP's residential IP gets blocked,
  that's signal — we re-evaluate, we don't escalate.
- No auto-OTP loop (per BUILD_PLAN §3).
- No cold-tier mass detail fetch "just in case".
- No real-time push when offers change (could add later: diff
  `dining_offers` per snapshot, notify if a Hot-tier restaurant's
  best offer dropped or grew significantly).

---

## 9. Ready to start

All decisions locked. Recommended next move:

1. KP confirms "yes start", and answers one last sub-question:
   **does the Mac mini already have Homebrew + Node 20+ installed?**
   (If not, that's a 5-min prereq, not a real obstacle.)
2. I start **chunk 1** — the schema migration including the
   `dining_scrape_pages` table from §5 — same session.
3. Login CLIs (chunks 3–4) next, since those need ~10 min of KP's
   real-OTP time and block nothing else; we can do those in
   parallel with my work on §5a.

No more planning docs after this until something proves us wrong.
