# Dining tab — build plan v1

**Date**: 2026-05-16
**Status**: Awaiting KP sign-off on §6 decisions before any code.
**Supersedes**: §5 of `DINING_FEASIBILITY.md` (the card-first reframe).
**Scope locked**: Native listings + native offers across Zomato Dining
Out, Swiggy Dineout, EazyDiner. Cross-platform dedupe. Weekly refresh.
Card-stack layer is Phase 2, out of scope for this doc.

---

## 1. The user job, in one line

> "Tell me whether restaurant X is on any of the three apps and
> which one has the best offer right now, without me opening any
> of them."

Two derived UI questions fall out of that:
- **"Search a restaurant"** → row per app, offer side-by-side.
- **"Browse near me"** → ranked by best-offer-% across apps, with
  badges showing which apps it's on.

---

## 2. Why scraping (and why it's OK here)

We established in `DINING_FEASIBILITY.md` that no official API exists
for any of the three. The remaining honest path is reverse-engineering
the **mobile/web JSON APIs** each app's own frontend already uses.

Mitigations that make this defensible for a single-user personal app:
- **Single-user, single-IP, low rate** (1 city/week × 3 apps ≈ ~50
  requests/week). Nothing here looks like a bot farm.
- **Authenticated as KP's own real account** on each platform (so we
  see exactly what he'd see opening the app — no inflated access).
- **Respect `robots.txt`-spirit even where not enforced**: jittered
  delays, no parallelism per host, honour 429s with exponential
  backoff, abort the run on first 403.
- **Encrypted token storage** via the existing `lib/crypto.ts`.
  Tokens never enter git, logs, or client bundles.

What this is NOT: a public service, a reseller, a competitor.
If any platform sends a takedown, we kill that scraper same-day.

---

## 3. Auth model — one-time login per app, weekly token refresh

All three apps use phone+OTP. A truly automated OTP loop is fragile
and arguably crosses an ethics line. Better:

1. **Manual one-time login** via a small CLI helper:
   `npx tsx scripts/dining-login.ts zomato`
   Opens a Playwright browser window, KP logs in once with his real
   number + OTP, the script captures the session cookies / bearer
   token, encrypts via `encrypt()`, stores in a new
   `dining_sessions` Supabase table (`platform`, `encrypted_token`,
   `expires_at`, `last_validated_at`).

2. **Weekly cron** (Vercel cron or a GitHub Action) calls each
   scraper. Before each run, hit a cheap `/me`-equivalent endpoint
   to validate the token. If 401, the run aborts with a Supabase
   `dining_alerts` row → CardIQ UI shows a red "re-login Swiggy"
   banner. KP re-runs the login CLI. Total downtime per re-auth
   event: ~2 minutes of his time, ~once every 30–90 days.

3. **No silent token refresh attempts** — those are exactly the
   automation patterns platforms flag on. Token expired = surface
   it, ask KP, move on.

This is the same shape as CardIQ's existing Gmail OAuth: long-lived
auth obtained interactively once, encrypted at rest, validated each
run, fail-loud on expiry. Conceptually consistent.

---

## 4. Data model (Supabase, new tables only)

```sql
-- A canonical restaurant identity, deduped across platforms.
create table dining_restaurants (
  id              uuid primary key default gen_random_uuid(),
  canonical_name  text not null,           -- "Toit Brewpub"
  area            text,                    -- "Indiranagar"
  city            text not null,           -- "Bangalore"
  lat             numeric(9,6),
  lng             numeric(9,6),
  cuisines        text[],
  price_for_two   integer,                 -- INR, midpoint when ranged
  first_seen_at   timestamptz default now(),
  last_seen_at    timestamptz default now()
);
create unique index on dining_restaurants (canonical_name, lat, lng);

-- One row per (restaurant × platform) — the join key for dedupe.
create table dining_listings (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid references dining_restaurants(id) on delete cascade,
  platform        text not null check (platform in ('zomato','swiggy','eazydiner')),
  external_id     text not null,           -- platform's own restaurant id
  url             text not null,           -- deep link
  raw             jsonb,                   -- full payload, for re-parsing without re-scraping
  last_scraped_at timestamptz default now(),
  unique (platform, external_id)
);

-- One row per offer per listing. Offers come and go; we snapshot weekly.
create table dining_offers (
  id              uuid primary key default gen_random_uuid(),
  listing_id      uuid references dining_listings(id) on delete cascade,
  offer_type      text,                    -- 'flat_discount' | 'bogo' | 'prime' | 'bank_card' | 'voucher'
  headline        text not null,           -- "Flat 25% off on total bill"
  discount_pct    integer,                 -- nullable for non-percentage offers
  min_bill        integer,
  max_discount    integer,
  terms           text,
  active_from     date,
  active_to       date,
  snapshot_run_id uuid not null,           -- groups offers seen in one scrape run
  observed_at     timestamptz default now()
);

-- Bookkeeping per weekly run.
create table dining_runs (
  id              uuid primary key default gen_random_uuid(),
  started_at      timestamptz default now(),
  finished_at     timestamptz,
  platform        text not null,
  city            text not null,
  status          text,                    -- 'ok' | 'partial' | 'auth_failed' | 'blocked'
  listings_seen   integer,
  offers_seen     integer,
  error           text
);
```

Note the **separation of concerns** that mirrors `txn-enrich.ts`:
listings are stable identity, offers are time-series snapshots.
Per L20 (snapshot at the event, not re-derived), every scrape run
gets its own `snapshot_run_id` so we can answer "what offers existed
last Tuesday?" without time-travel guesswork.

---

## 5. Cross-platform dedupe (the actually-hard part)

The user-visible value of this tab IS the dedupe — "Toit is on
Zomato AND Swiggy AND EazyDiner, here are all three offers side-by-
side". Each platform names and geocodes the same place differently
("Toit" vs "Toit Brewpub" vs "Toit - Indiranagar"; lat/lng off by
30m). Two-stage matcher:

1. **Cheap pass — exact/near-exact**: lowercase + strip suffixes
   ("Pvt Ltd", "- Indiranagar"), Levenshtein ≤ 2 on cleaned name,
   haversine distance < 100m. ~70% of matches go through here.

2. **Expensive pass — embedding similarity** for the remainder:
   reuse the Anthropic key already wired into `app/api/chat/route.ts`
   to call a cheap embedding model on `name + area + cuisines`,
   cosine > 0.92 + haversine < 200m. Cached forever per
   `(zomato_id, swiggy_id)` pair so we only ever pay once per pair.

3. **Manual override table** for the rest:
   ```sql
   create table dining_manual_links (
     platform_a text, external_id_a text,
     platform_b text, external_id_b text,
     decision text check (decision in ('same','different')),
     created_at timestamptz default now(),
     primary key (platform_a, external_id_a, platform_b, external_id_b)
   );
   ```
   Tab has a tiny "review N candidate matches" widget for the cases
   the auto-matcher flagged but didn't auto-merge.

This is **explicit > implicit** (L14): we don't silently merge
ambiguous matches, we surface them.

---

## 6. Decisions KP needs to make before we code

> ⚠️ The whole plan hinges on these. Pick one option for each.

**D1 — Cities scope, v1**
- (a) Bangalore only.
- (b) Bangalore + Mumbai + Delhi NCR.
- (c) All metros (≈12 cities). Linearly more requests + storage.
- **Default if KP shrugs:** (a). Easiest to keep green; expand later.

**D2 — Where does the scraper run**
- (a) Vercel cron + serverless function. Free, but Playwright on
  Vercel is a known pain (binary size, cold starts).
- (b) GitHub Action, weekly cron. Free, clean Playwright env, writes
  to Supabase via the service-role key. Recommended.
- (c) KP's Mac via local cron / launchd. Always-fresh IP residential,
  but only runs when laptop's on.
- **Default:** (b).

**D3 — Storage of `raw` JSON blobs**
- (a) Keep in Supabase (`jsonb`). Easiest, but balloons the row size.
- (b) Push to Supabase Storage as gzipped files, keep only a URL in
  the row. Cheaper at scale, more moving parts.
- **Default:** (a) for v1, revisit if any single platform's payload
  pushes past ~50KB/restaurant.

**D4 — How much of the offer terms do we keep**
- (a) Headline + discount % only. Clean UI, may lose nuance ("valid
  on weekdays except holidays, dine-in only, …").
- (b) Headline + full terms text. UI shows headline, expandable to
  full terms.
- **Default:** (b). The fine print is exactly where the "is this
  actually a good deal" lives.

**D5 — Re-auth alerting**
- (a) Red banner in the Dining tab when any session expires.
- (b) Above + a Gmail to KP (we already have his email from the
  Gmail OAuth scope).
- **Default:** (a). KP opens the app weekly anyway.

---

## 7. Build phases (each independently revertable — L15)

Once §6 is signed off:

| # | Chunk | What ships | Risk |
|---|---|---|---|
| 1 | Schema migration (§4) + manual link table | Empty tables, no callers | zero |
| 2 | `lib/dining/normalize.ts` — pure helpers for name/address cleaning, haversine, fuzzy match — with unit tests (L17) | Importable but unused | zero |
| 3 | `scripts/dining-login.ts` — Playwright login flow → `dining_sessions` row | One CLI command works for one platform | low |
| 4 | Repeat (3) for the other two platforms | All three CLIs work | low |
| 5 | `lib/dining/scrapers/{zomato,swiggy,eazydiner}.ts` — pull listings + offers for one city, write `raw` only, no dedupe | One run populates `dining_listings` for one platform | medium |
| 6 | Dedupe matcher (§5) + run end-to-end for v1 city | `dining_restaurants` populated, offers attached | medium |
| 7 | `app/api/dining/...` routes + `DiningTab.tsx` component (search + browse) | Tab visible in nav, read-only | low |
| 8 | Weekly scheduler (GitHub Action) + `dining_runs` bookkeeping + auth-expiry banner | Self-running, surfaces failures | low |
| 9 | Manual-link review widget for ambiguous matches | Closes the dedupe loop | low |

Each chunk: code → tests → commit → next. No big-bangs. Every
commit leaves CardIQ green (74 existing tests stay passing; new
tests add cleanly).

---

## 8. What this plan deliberately does NOT do (YAGNI)

- No card-linked offer layer (that's Phase 2, distinct project).
- No real-time scraping on user search — strictly weekly batch.
- No push notifications for new offers (idea log, not v1).
- No mobile-specific UI (CardIQ doesn't have one anywhere).
- No offer history/trend charts (data accumulates from week 1;
  charts are a thin addition later if KP wants them).
- No auto-OTP automation — manual login is the contract (§3).

---

## 9. Risk register (the things that will actually go wrong)

| Risk | Likelihood | Blast radius | Mitigation |
|---|---|---|---|
| One platform changes its JSON shape | High (quarterly) | One scraper red | Each scraper isolated, others keep running. `dining_runs` flags partial. Fix is a single-file diff. |
| Cloudflare/Akamai bot challenge | Medium | Scraper blocked | Slow down, jitter, switch to residential IP (KP's Mac via D2c) for that platform only. |
| Token expires sooner than expected | Medium | One platform stale until KP re-auths | §3 banner. Worst case: stale data for a few days. |
| Dedupe false-positive merges two restaurants | Low–medium | Confusing UI for that row | Manual-link table can split them; merges are reversible because raw rows survive (L40 — soft, not destructive). |
| Supabase free-tier limit | Low | Writes fail | Estimated ~5MB/week even for option D1c. We're orders of magnitude under the 500MB free cap. |
| Walmart network blocks scraper run from laptop | Medium (if D2c) | No data that week | D2b GitHub Action sidesteps entirely. |

---

## 10. Definition of done for v1

- [ ] All three platforms have a green run in `dining_runs` for the
      chosen v1 city, within the last 7 days.
- [ ] Searching "Toit" in the Dining tab returns one row, three
      platform badges, three offers side-by-side, best one
      highlighted.
- [ ] Browsing the tab without a search returns the city's
      restaurants sorted by best offer %, paginated.
- [ ] A deliberately expired token surfaces the re-auth banner
      within one run cycle.
- [ ] `npx vitest run` is still ≥74 passing (existing) + new tests
      green. `npx tsc --noEmit` clean.
- [ ] HANDOFF.md updated with the new tab + new tables; LEARNINGS.md
      gets whatever new project-specific lesson we paid for.

---

## 11. Effort estimate

End-to-end, with KP doing logins (~10 min total of his time across
the three platforms): **5–7 focused evenings** for chunks 1–8, plus
~2 more for chunk 9 and polish. Single biggest unknown is chunk 5
(scrapers) — could be a day per platform or three, depending on how
locked-down each API turns out to be in May 2026.

---

## 12. One-line ask back to KP

**Sign off on D1–D5 in §6 and I'll start with chunk 1 (schema
migration) the same session.** Defaults are sensible if you don't
have strong opinions on any of them.
