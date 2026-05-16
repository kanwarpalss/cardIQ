-- 010: Dining tab schema.
--
-- Adds five tables for the Dining feature (see docs/DINING_BUILD_PLAN.md
-- and docs/DINING_SCRAPE_STRATEGY.md).
--
-- Design notes
-- ────────────
-- * `dining_restaurants` is the canonical identity, deduped across
--   platforms. Listings on Zomato/Swiggy/EazyDiner point at this.
-- * `dining_listings` is the per-platform mapping. Stable identity over
--   time. `raw` is the full last payload so we can re-parse without
--   re-scraping.
-- * `dining_offers` is a time-series snapshot. Every weekly scrape run
--   inserts the offers it saw, tagged with snapshot_run_id, so we can
--   answer "what offers existed last Tuesday?" without time-travel.
-- * `dining_runs` is one bookkeeping row per (platform × city × run).
-- * `dining_scrape_pages` tracks every list-endpoint page hit so a
--   crashed scrape can resume from the exact page that failed.
-- * `dining_sessions` stores the encrypted session token per platform
--   (one row per platform per user). Mirrors how Gmail OAuth is held.
-- * `dining_manual_links` is the audit table for cross-platform dedupe
--   decisions ("Toit on Zomato == Toit on Swiggy"). Explicit > implicit.
--
-- RLS: restaurant / listing / offer / run / page tables are GLOBAL
-- (shared across users — though right now CardIQ is single-user, the
-- data itself is not user-specific). sessions + manual_links carry
-- user_id and RLS, since they encode user secrets / user judgement.
--
-- All DDL is idempotent. Safe to re-run.

-- ============================================================
-- CANONICAL RESTAURANT IDENTITY
-- ============================================================
create table if not exists dining_restaurants (
  id              uuid primary key default gen_random_uuid(),
  canonical_name  text not null,                  -- "Toit Brewpub"
  area            text,                           -- "Indiranagar"
  city            text not null,                  -- "Bangalore"
  lat             numeric(9,6),
  lng             numeric(9,6),
  cuisines        text[] default '{}',
  price_for_two   integer,                        -- INR, midpoint when ranged
  first_seen_at   timestamptz default now(),
  last_seen_at    timestamptz default now()
);

-- Restaurant-uniqueness is (name, lat, lng) once normalised.
-- The matcher in lib/dining/normalize.ts decides which existing row a
-- new listing maps to; this index is just a backstop against accidental
-- exact-dupes.
create unique index if not exists dining_restaurants_name_geo_uidx
  on dining_restaurants (canonical_name, lat, lng);

create index if not exists dining_restaurants_city_area_idx
  on dining_restaurants (city, area);

-- ============================================================
-- PER-PLATFORM LISTING
-- ============================================================
create table if not exists dining_listings (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid references dining_restaurants(id) on delete cascade,
  platform        text not null check (platform in ('zomato','swiggy','eazydiner')),
  external_id     text not null,                  -- platform's own restaurant id
  url             text not null,                  -- deep link
  raw             jsonb,                          -- full payload, last seen
  headline_offer  text,                           -- e.g. "Flat 25% off" — cheap change-detection signal
  last_scraped_at timestamptz default now(),
  unique (platform, external_id)
);

create index if not exists dining_listings_restaurant_idx
  on dining_listings (restaurant_id);

create index if not exists dining_listings_platform_idx
  on dining_listings (platform);

-- ============================================================
-- TIME-SERIES OFFERS
-- ============================================================
create table if not exists dining_offers (
  id              uuid primary key default gen_random_uuid(),
  listing_id      uuid not null references dining_listings(id) on delete cascade,
  offer_type      text,                           -- 'flat_discount' | 'bogo' | 'prime' | 'voucher' | 'other'
  headline        text not null,                  -- "Flat 25% off on total bill"
  discount_pct    integer,                        -- nullable for non-% offers
  min_bill        integer,
  max_discount    integer,
  terms           text,                           -- full T&Cs (per D4)
  active_from     date,
  active_to       date,
  snapshot_run_id uuid not null,                  -- groups offers seen in one scrape run
  observed_at     timestamptz default now()
);

create index if not exists dining_offers_listing_observed_idx
  on dining_offers (listing_id, observed_at desc);

create index if not exists dining_offers_snapshot_idx
  on dining_offers (snapshot_run_id);

-- ============================================================
-- BOOKKEEPING — one row per scrape run, one row per page within a run
-- ============================================================
create table if not exists dining_runs (
  id              uuid primary key default gen_random_uuid(),
  started_at      timestamptz default now(),
  finished_at     timestamptz,
  platform        text not null,
  city            text not null,
  kind            text not null check (kind in ('discovery','hot','warm','cold','adhoc')),
  status          text,                           -- 'ok' | 'partial' | 'auth_failed' | 'blocked' | 'running'
  listings_seen   integer default 0,
  offers_seen     integer default 0,
  error           text
);

create index if not exists dining_runs_platform_started_idx
  on dining_runs (platform, started_at desc);

create table if not exists dining_scrape_pages (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references dining_runs(id) on delete cascade,
  platform        text not null,
  locality        text not null,
  page            integer not null,
  status          text not null,                  -- 'ok' | 'http_4xx' | 'http_5xx' | 'parse_failed' | 'rate_limited'
  http_code       integer,
  fetched_at      timestamptz default now(),
  unique (run_id, platform, locality, page)
);

create index if not exists dining_scrape_pages_resume_idx
  on dining_scrape_pages (run_id, status);

-- ============================================================
-- PER-USER: encrypted session tokens
-- ============================================================
create table if not exists dining_sessions (
  user_id          uuid not null references auth.users(id) on delete cascade,
  platform         text not null check (platform in ('zomato','swiggy','eazydiner')),
  encrypted_token  text not null,                 -- aes-256-gcm via lib/crypto.ts
  expires_at       timestamptz,                   -- best-effort; we still validate per run
  last_validated_at timestamptz,
  created_at       timestamptz default now(),
  primary key (user_id, platform)
);

alter table dining_sessions enable row level security;
drop policy if exists "own dining sessions" on dining_sessions;
create policy "own dining sessions" on dining_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- PER-USER: manual dedupe decisions
-- ============================================================
-- When the auto-matcher (cheap fuzzy + embedding) isn't confident
-- enough, the UI surfaces the candidate pair and KP marks it 'same'
-- or 'different'. We never silently merge.
create table if not exists dining_manual_links (
  user_id        uuid not null references auth.users(id) on delete cascade,
  platform_a     text not null,
  external_id_a  text not null,
  platform_b     text not null,
  external_id_b  text not null,
  decision       text not null check (decision in ('same','different')),
  created_at     timestamptz default now(),
  primary key (user_id, platform_a, external_id_a, platform_b, external_id_b)
);

alter table dining_manual_links enable row level security;
drop policy if exists "own dining links" on dining_manual_links;
create policy "own dining links" on dining_manual_links
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
