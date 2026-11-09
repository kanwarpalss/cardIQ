-- 024: Deal finder — points sales and transfer bonuses found in KP's mail and
-- on points blogs by the daily job (scripts/find-deals.ts, PM2 on the Mac mini).
-- Run manually in Supabase SQL Editor AFTER 022.
-- (023 is reserved by the statement-reconcile branch's excluded_messages.)
-- Safe to re-run: all DDL uses IF NOT EXISTS / DROP IF EXISTS guards.
--
-- Three tables, one concern each:
--   * deals            — the offers themselves. Only FACTS from the source are
--                        stored; whether KP's cards can use a deal and how good
--                        it is are worked out on screen (src/lib/deals/score.ts),
--                        so adding a card re-scores everything with no re-read.
--   * deal_seen_items  — every email/blog post the job has looked at, with the
--                        outcome, so nothing is downloaded or sent to the AI
--                        reader twice (same rule as gmail_seen_messages).
--   * deal_runs        — one row per run: the job's health record, shown on the
--                        Deals screen so a stopped job can't fail silently.
-- The job writes with the service-role key; the app only reads.

create table if not exists deals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  dedup_key text not null,

  kind text not null check (kind in ('buy_points','transfer_bonus','ratio_change')),
  program text not null,               -- src/lib/transfer-partners/programs.ts key
  from_bank text check (from_bank in ('axis','hdfc','hsbc','icici','amex')),
  from_program text,
  from_other text,
  bonus_pct numeric(6,2) check (bonus_pct is null or (bonus_pct > 0 and bonus_pct <= 300)),
  discount_pct numeric(5,2) check (discount_pct is null or (discount_pct > 0 and discount_pct < 100)),
  starts_on date,
  ends_on date,
  targeted boolean not null default false,

  headline text not null,
  evidence text not null default '',
  evidence_verified boolean not null default false,
  -- [{kind, item_id, origin, title, url, seen_at}] — every email/post that
  -- mentioned this offer.
  sources jsonb not null default '[]'::jsonb,

  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  created_at timestamptz default now(),
  unique (user_id, dedup_key)
);

create index if not exists deals_user_seen_idx on deals (user_id, last_seen_at desc);

alter table deals enable row level security;
drop policy if exists "own deals" on deals;
create policy "own deals" on deals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists deal_seen_items (
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('email','blog')),
  item_id text not null,                -- Gmail hex id, or the post URL
  outcome text not null check (outcome in ('skipped','not_deal','deal','error')),
  reason text,
  attempts integer not null default 1,
  seen_at timestamptz not null default now(),
  primary key (user_id, source, item_id)
);

alter table deal_seen_items enable row level security;
drop policy if exists "own deal seen items" on deal_seen_items;
create policy "own deal seen items" on deal_seen_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists deal_runs (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean not null default false,
  summary text not null default ''
);

create index if not exists deal_runs_user_started_idx on deal_runs (user_id, started_at desc);

alter table deal_runs enable row level security;
drop policy if exists "own deal runs" on deal_runs;
create policy "own deal runs" on deal_runs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
