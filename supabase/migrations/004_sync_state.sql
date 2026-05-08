-- Migration 004: Incremental Gmail sync state
-- Prevents re-fetching emails that have already been processed.
--
-- Two tables:
--
-- gmail_sync_state  — one row per (user, sender).
--   Stores the internalDate (ms epoch) of the newest message ever synced from
--   that sender. Next sync uses `after:<last_internal_date_seconds>` so only
--   genuinely new emails are fetched.
--
-- gmail_sync_ranges — covered date intervals per (user, sender).
--   Tracks which historical windows have been fully fetched, so a backfill
--   request (e.g. "get me 24 months") only fetches the gap rather than
--   repeating the already-covered window.

-- ============================================================
-- GMAIL_SYNC_STATE — forward cursor (newest message seen)
-- ============================================================
create table if not exists gmail_sync_state (
  user_id           uuid not null references auth.users(id) on delete cascade,
  sender            text not null,          -- e.g. 'alerts@axisbank.com'
  last_internal_date bigint,                -- ms epoch of newest synced message
  last_synced_at    timestamptz,            -- wall-clock time of last successful sync
  message_count     int default 0,          -- cumulative messages processed from this sender
  primary key (user_id, sender)
);

alter table gmail_sync_state enable row level security;
create policy "own sync state" on gmail_sync_state
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- GMAIL_SYNC_RANGES — coverage intervals (for backfills)
-- ============================================================
create table if not exists gmail_sync_ranges (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  sender     text not null,
  range_start date not null,   -- inclusive start of covered window
  range_end   date not null,   -- inclusive end of covered window
  created_at  timestamptz default now()
);

alter table gmail_sync_ranges enable row level security;
create policy "own sync ranges" on gmail_sync_ranges
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists gmail_sync_ranges_user_sender_idx
  on gmail_sync_ranges (user_id, sender, range_start, range_end);
