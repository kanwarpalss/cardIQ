-- 013: Scale dining schema for "all of Bangalore" (5K-8K canonical restaurants,
-- ~27K District outlets, ~2K EazyDiner pages). Original schema (010) was sized
-- for the 30-restaurant hand-curated set.
--
-- Changes
-- ───────
-- 1. Enable PostGIS + pg_trgm extensions.
-- 2. dining_restaurants gains `geog geography(point)` — populated from lat/lng
--    via a trigger so we don't have to remember to set it in app code.
--    Indexed with GIST → spatial pre-filter goes from O(n) in-memory to O(log n).
-- 3. dining_restaurants.canonical_name gains a trigram GIN index → name fuzzy-
--    match pre-filter goes from full-table Levenshtein to indexed similarity.
-- 4. dining_listings gains `discovered_at timestamptz` so we can tell
--    "discovered this week" from "scraped this week".
--
-- NOT in this migration (per Q2 — weekly-only freshness, no tiering):
-- - No `tier` column. All listings scraped at the same cadence.
--
-- Idempotent. Safe to re-run.
-- Apply via: ./scripts/db.sh push

-- ── 1. Extensions ────────────────────────────────────────────────────
create extension if not exists postgis;
create extension if not exists pg_trgm;

-- ── 2. Geography column + auto-populate trigger ──────────────────────
alter table dining_restaurants
  add column if not exists geog geography(point, 4326);

-- Backfill any existing rows with lat/lng → geog.
update dining_restaurants
   set geog = st_setsrid(st_makepoint(lng::float, lat::float), 4326)::geography
 where geog is null and lat is not null and lng is not null;

-- Trigger: keep geog in sync with lat/lng on every insert/update.
create or replace function dining_restaurants_set_geog() returns trigger as $$
begin
  if new.lat is not null and new.lng is not null then
    new.geog := st_setsrid(st_makepoint(new.lng::float, new.lat::float), 4326)::geography;
  else
    new.geog := null;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists dining_restaurants_geog_sync on dining_restaurants;
create trigger dining_restaurants_geog_sync
  before insert or update of lat, lng on dining_restaurants
  for each row execute function dining_restaurants_set_geog();

-- GIST spatial index for ST_DWithin queries.
create index if not exists dining_restaurants_geog_gix
  on dining_restaurants using gist (geog);

-- ── 3. Trigram index on canonical_name ───────────────────────────────
create index if not exists dining_restaurants_name_trgm_idx
  on dining_restaurants using gin (canonical_name gin_trgm_ops);

-- ── 4. discovered_at on listings ─────────────────────────────────────
alter table dining_listings
  add column if not exists discovered_at timestamptz default now();

-- For listings that pre-date this column, treat first scrape as discovery.
update dining_listings
   set discovered_at = coalesce(last_scraped_at, now())
 where discovered_at is null;

create index if not exists dining_listings_discovered_idx
  on dining_listings (discovered_at desc);
