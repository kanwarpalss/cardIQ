-- 014: Dedupe review queue for the manual-link review widget.
--
-- When dining-discover.ts can't confidently merge two listings into one
-- canonical restaurant (confidence = 'maybe'), it writes a row here
-- instead of silently merging. The review UI surfaces these pairs so KP
-- can mark them 'same' or 'different', which then gets written to
-- dining_manual_links.
--
-- No user_id — the queue is global (discovery runs without user context).
-- Decisions written to dining_manual_links do carry user_id.
--
-- Idempotent. Safe to re-run.

create table if not exists dining_dedupe_queue (
  id               uuid primary key default gen_random_uuid(),
  -- Listing A (the "incoming" listing that triggered the review)
  platform_a       text not null,
  external_id_a    text not null,
  name_a           text,
  -- Listing B (the existing canonical's representative listing)
  platform_b       text not null,
  external_id_b    text not null,
  name_b           text,
  -- The canonical both have been provisionally attached to
  canonical_id     uuid references dining_restaurants(id) on delete cascade,
  -- Reason string from dedupe engine (e.g. "maybe: 'toit' vs 'toit brewpub' (~0m)")
  reason           text,
  status           text not null default 'pending'
                   check (status in ('pending', 'resolved', 'auto_merged')),
  created_at       timestamptz default now(),
  resolved_at      timestamptz,
  -- Prevent duplicate queue entries for the same pair
  unique (platform_a, external_id_a, platform_b, external_id_b)
);

create index if not exists dining_dedupe_queue_status_idx
  on dining_dedupe_queue (status, created_at desc);
